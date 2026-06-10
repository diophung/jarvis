import { newId, nowIso } from '@donna/core';
import type { Db } from '@donna/db';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { AuditService } from './context.js';
import { badRequest, unauthorized } from './lib/http-errors.js';

const SESSION_COOKIE = 'donna_session';

interface AuthDeps {
  db: Db;
  config: AppConfig;
  audit: AuditService;
}

interface SessionInfo {
  userId: string;
  workspaceId: string;
}

/** Look up (and memoize) the owner user + workspace for local auto-login. */
function makeOwnerResolver(db: Db) {
  let cached: SessionInfo | null = null;
  return async (): Promise<SessionInfo | null> => {
    if (cached) return cached;
    const user = await db
      .selectFrom('users')
      .select(['id'])
      .where('role', '=', 'owner')
      .orderBy('createdAt', 'asc')
      .executeTakeFirst();
    if (!user) return null;
    const ws = await db
      .selectFrom('workspaces')
      .select(['id'])
      .where('ownerUserId', '=', user.id)
      .executeTakeFirst();
    if (!ws) return null;
    cached = { userId: user.id, workspaceId: ws.id };
    return cached;
  };
}

/**
 * Session auth. Local mode: the owner user is auto-logged-in (no login
 * screen). Password mode: email+password login sets the signed cookie.
 */
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { db, config, audit } = deps;
  const resolveOwner = makeOwnerResolver(db);

  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    // Only API routes need auth; static assets and health are public.
    if (!url.startsWith('/api/') || url === '/api/health' || url === '/api/auth/login') return;

    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const [userId, workspaceId] = unsigned.value.split('|');
        if (userId && workspaceId) {
          request.userId = userId;
          request.workspaceId = workspaceId;
          return;
        }
      }
    }

    if (config.env.DONNA_AUTH_MODE === 'local') {
      const owner = await resolveOwner();
      if (owner) {
        request.userId = owner.userId;
        request.workspaceId = owner.workspaceId;
        reply.setCookie(SESSION_COOKIE, `${owner.userId}|${owner.workspaceId}`, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          signed: true,
          maxAge: 60 * 60 * 24 * 30,
        });
        return;
      }
    }
    reply.code(401).send({ error: { code: 'unauthorized', message: 'Not authenticated' } });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .safeParse(request.body);
    if (!body.success) throw badRequest('Email and password are required');
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', body.data.email.toLowerCase())
      .executeTakeFirst();
    if (!user?.passwordHash || !(await bcrypt.compare(body.data.password, user.passwordHash))) {
      throw unauthorized('Invalid email or password');
    }
    const ws = await db
      .selectFrom('workspaces')
      .select(['id'])
      .where('ownerUserId', '=', user.id)
      .executeTakeFirst();
    if (!ws) throw unauthorized('No workspace for this user');
    reply.setCookie(SESSION_COOKIE, `${user.id}|${ws.id}`, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      maxAge: 60 * 60 * 24 * 30,
    });
    await audit.log({
      workspaceId: ws.id,
      userId: user.id,
      eventType: 'auth.login',
      actor: 'user',
      summary: `${user.email} logged in`,
    });
    return { user: { ...user, passwordHash: undefined } };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (request.workspaceId) {
      await audit.log({
        workspaceId: request.workspaceId,
        userId: request.userId,
        eventType: 'auth.logout',
        actor: 'user',
        summary: 'Logged out',
      });
    }
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'role', 'createdAt', 'updatedAt'])
      .where('id', '=', request.userId)
      .executeTakeFirst();
    const workspace = await db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!user || !workspace) throw unauthorized();
    return { user, workspace, authMode: config.env.DONNA_AUTH_MODE };
  });

  app.patch('/api/me', async (request) => {
    const body = z
      .object({ name: z.string().min(1).max(120).optional(), email: z.string().email().optional() })
      .safeParse(request.body);
    if (!body.success) throw badRequest('Invalid profile fields');
    const patch: Record<string, string> = { updatedAt: nowIso() };
    if (body.data.name) patch.name = body.data.name;
    if (body.data.email) patch.email = body.data.email.toLowerCase();
    await db.updateTable('users').set(patch).where('id', '=', request.userId).execute();
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'role', 'createdAt', 'updatedAt'])
      .where('id', '=', request.userId)
      .executeTakeFirstOrThrow();
    return { user };
  });
}

/** Create the initial owner user + workspace if none exist. Returns ids. */
export async function ensureOwner(db: Db, config: AppConfig): Promise<SessionInfo> {
  const existing = await db
    .selectFrom('users')
    .select(['id'])
    .where('role', '=', 'owner')
    .orderBy('createdAt', 'asc')
    .executeTakeFirst();
  if (existing) {
    const ws = await db
      .selectFrom('workspaces')
      .select(['id'])
      .where('ownerUserId', '=', existing.id)
      .executeTakeFirstOrThrow();
    return { userId: existing.id, workspaceId: ws.id };
  }
  const now = nowIso();
  const userId = newId('usr');
  const workspaceId = newId('wsp');
  const passwordHash = config.env.DONNA_OWNER_PASSWORD
    ? await bcrypt.hash(config.env.DONNA_OWNER_PASSWORD, 10)
    : null;
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: config.env.DONNA_OWNER_EMAIL.toLowerCase(),
      name: config.env.DONNA_OWNER_NAME,
      passwordHash,
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      ownerUserId: userId,
      name: `${config.env.DONNA_OWNER_NAME}'s Workspace`,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return { userId, workspaceId };
}
