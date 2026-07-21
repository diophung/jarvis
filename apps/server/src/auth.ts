import { randomBytes } from 'node:crypto';
import { newId, nowIso } from '@donna/core';
import type { Db } from '@donna/db';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { AuditService } from './context.js';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from './lib/http-errors.js';
import { isUniqueViolation, sanitizeUser, provisionUser } from './services/users.js';
import type { SessionsService } from './services/sessions.js';

const SESSION_COOKIE = 'donna_session';
const SESSION_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;

/** Paths under /api that never require a session. */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/health/ready',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/methods',
]);
/** OAuth login start/callback are browser navigations that happen pre-session. */
const PUBLIC_PREFIX = '/api/auth/oauth/';

interface AuthDeps {
  db: Db;
  config: AppConfig;
  audit: AuditService;
  sessions: SessionsService;
}

interface SessionInfo {
  userId: string;
  workspaceId: string;
}

// ---------- password policy ----------

/** Common passwords (>=10 chars; shorter ones fail the length rule anyway). */
const COMMON_PASSWORDS = new Set([
  'password123',
  'password1234',
  'password12345',
  'password!123',
  'qwerty123456',
  'qwertyuiop123',
  '1234567890',
  '12345678910',
  '123456789012',
  'iloveyou123',
  'admin123456',
  'administrator',
  'letmein12345',
  'welcome12345',
  'welcome123456',
  'abc123456789',
  'sunshine12345',
  'princess12345',
  'football12345',
  'trustno1trustno1',
]);

/** Returns a human-readable problem with the password, or null when it's OK. */
export function validatePassword(password: string, email: string): string | null {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters long.';
  }
  if (password.length > 200) {
    return 'Password must be at most 200 characters long.';
  }
  if (password.toLowerCase() === email.toLowerCase()) {
    return 'Password must be different from your email address.';
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is too common. Please choose a stronger one.';
  }
  return null;
}

// ---------- login rate limiting ----------

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;
/** Per-IP cap across ALL emails: an attacker rotating emails would otherwise
 * never trip the per-`${email}|${ip}` limit. */
const RATE_LIMIT_MAX_FAILURES_PER_IP = 20;

type FailureMap = Map<string, { count: number; windowStartMs: number }>;

/**
 * In-memory failed-login trackers: one keyed `${email}|${ip}`, one keyed by
 * ip alone. NOTE: per-process only — in a multi-instance deployment each
 * instance counts independently, so attackers get N*limit attempts.
 * Acceptable for self-hosted v1.1; move to a shared store (DB/Redis) if
 * Donna ever runs horizontally scaled.
 */
const loginFailures: FailureMap = new Map();
const ipLoginFailures: FailureMap = new Map();

function pruneLoginFailures(map: FailureMap, nowMs: number): void {
  if (map.size < 1000) return;
  for (const [key, entry] of map) {
    if (nowMs - entry.windowStartMs > RATE_LIMIT_WINDOW_MS) map.delete(key);
  }
}

function isRateLimited(map: FailureMap, key: string, nowMs: number, max: number): boolean {
  const entry = map.get(key);
  if (!entry) return false;
  if (nowMs - entry.windowStartMs > RATE_LIMIT_WINDOW_MS) {
    map.delete(key);
    return false;
  }
  return entry.count >= max;
}

function recordLoginFailure(map: FailureMap, key: string, nowMs: number): void {
  pruneLoginFailures(map, nowMs);
  const entry = map.get(key);
  if (!entry || nowMs - entry.windowStartMs > RATE_LIMIT_WINDOW_MS) {
    map.set(key, { count: 1, windowStartMs: nowMs });
  } else {
    entry.count += 1;
  }
}

/** Test hook: clear the per-process failed-login counters. */
export function resetLoginRateLimiter(): void {
  loginFailures.clear();
  ipLoginFailures.clear();
}

// ---------- CSRF origin checking ----------

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** OAuth provider callbacks are exempt from the Origin check: Apple's
 * form_post callback is a legitimate cross-site POST. */
const CSRF_EXEMPT_RE = /^\/api\/auth\/oauth\/[^/]+\/callback$/;

/** Normalized origin of a URL/origin string, or null when unparseable. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// ---------- helpers ----------

/**
 * Local-mode auto-login: one memoized session per owner so cookieless
 * clients (curl, scripts) don't mint a new sessions row on every request.
 * Re-validated against the DB before reuse; the token is never logged.
 */
const localAutoSessions = new Map<string, { token: string; expiresAtMs: number }>();

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

function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env.DONNA_COOKIE_SECURE,
    signed: true,
    maxAge: SESSION_COOKIE_MAX_AGE_S,
  });
}

function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env.DONNA_COOKIE_SECURE,
  });
}

function requestMeta(request: FastifyRequest): { userAgent: string | null; ip: string | null } {
  const ua = request.headers['user-agent'];
  return { userAgent: typeof ua === 'string' ? ua : null, ip: request.ip ?? null };
}

const invalidCredentials = () =>
  new HttpError(401, 'Invalid email or password', 'invalid_credentials');

/** bcrypt hash of a per-process random value; compared against for unknown or
 * passwordless emails so response time does not reveal account existence.
 * Never a successful match: passwordOk additionally requires a real hash. */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('base64url'), 10);

/**
 * Session auth backed by the sessions table (opaque cookie token, sha256
 * hash stored). Local mode: the owner user is auto-logged-in (a real DB
 * session is still created). Password mode: register/login set the cookie.
 */
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { db, config, audit, sessions } = deps;
  const resolveOwner = makeOwnerResolver(db);

  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.decorateRequest('sessionId', '');

  // Origins allowed to make state-changing requests (CSRF defense).
  const allowedOrigins = new Set(
    [config.publicUrl, config.env.DONNA_WEB_ORIGIN]
      .map(originOf)
      .filter((o): o is string => o !== null),
  );

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    // Only API routes need auth; static assets are public.
    if (!url.startsWith('/api/')) return;

    // CSRF: browsers attach the attacker page's Origin to cross-site form
    // posts and fetches, so refuse state-changing requests from unknown
    // origins. Requests without an Origin header (curl, server-to-server)
    // pass. The OAuth callbacks are exempt (Apple's cross-site form_post).
    const origin = request.headers.origin;
    if (
      typeof origin === 'string' &&
      STATE_CHANGING_METHODS.has(request.method) &&
      !CSRF_EXEMPT_RE.test(url) &&
      !allowedOrigins.has(originOf(origin) ?? origin)
    ) {
      reply
        .code(403)
        .send({ error: { code: 'cross_origin_denied', message: 'Cross-origin request denied' } });
      return;
    }

    if (PUBLIC_PATHS.has(url) || url.startsWith(PUBLIC_PREFIX)) return;

    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const session = await sessions.validate(unsigned.value);
        if (session) {
          request.userId = session.userId;
          request.workspaceId = session.workspaceId;
          request.sessionId = session.id;
          return;
        }
      }
    }

    if (config.env.DONNA_AUTH_MODE === 'local') {
      const owner = await resolveOwner();
      if (owner) {
        // Reuse the memoized auto-login session while it is still valid so
        // repeated cookieless requests don't grow the sessions table.
        const cached = localAutoSessions.get(owner.userId);
        if (cached && cached.expiresAtMs > Date.now()) {
          const session = await sessions.validate(cached.token);
          if (session && session.userId === owner.userId) {
            cached.expiresAtMs = Date.parse(session.expiresAt);
            request.userId = session.userId;
            request.workspaceId = session.workspaceId;
            request.sessionId = session.id;
            setSessionCookie(reply, config, cached.token);
            return;
          }
          localAutoSessions.delete(owner.userId); // revoked/expired: mint anew
        }
        const { token, session } = await sessions.create(
          owner.userId,
          owner.workspaceId,
          requestMeta(request),
        );
        localAutoSessions.set(owner.userId, {
          token,
          expiresAtMs: Date.parse(session.expiresAt),
        });
        request.userId = owner.userId;
        request.workspaceId = owner.workspaceId;
        request.sessionId = session.id;
        setSessionCookie(reply, config, token);
        return;
      }
    }
    reply.code(401).send({ error: { code: 'unauthorized', message: 'Not authenticated' } });
  });

  app.post('/api/auth/register', async (request, reply) => {
    if (config.env.DONNA_AUTH_MODE !== 'password' || !config.env.DONNA_ALLOW_SIGNUP) {
      throw forbidden('Signup is not enabled');
    }
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().min(1).max(120),
        password: z.string().min(1),
      })
      .safeParse(request.body);
    if (!body.success) throw badRequest('Email, name and password are required');
    const { email, name, password } = body.data;

    const policyProblem = validatePassword(password, email);
    if (policyProblem) throw badRequest(policyProblem, 'weak_password');

    const passwordHash = await bcrypt.hash(password, 10);
    let provisioned: Awaited<ReturnType<typeof provisionUser>>;
    try {
      provisioned = await provisionUser(db, { email, name, passwordHash });
    } catch (err) {
      if ((err as { code?: string }).code === 'email_taken') {
        // Generic on purpose: must not reveal whether an account exists.
        throw badRequest('Could not create an account with these details.', 'registration_failed');
      }
      throw err;
    }
    const { user, workspace } = provisioned;

    const { token } = await sessions.create(user.id, workspace.id, requestMeta(request));
    setSessionCookie(reply, config, token);
    await audit.log({
      workspaceId: workspace.id,
      userId: user.id,
      eventType: 'auth.register',
      actor: 'user',
      summary: `${user.email} registered`,
      metadata: { method: 'password' },
    });
    return { user: sanitizeUser(user) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .safeParse(request.body);
    if (!body.success) throw badRequest('Email and password are required');
    const email = body.data.email.toLowerCase();

    const nowMs = Date.now();
    const ip = request.ip ?? 'unknown';
    const rateKey = `${email}|${ip}`;
    if (
      isRateLimited(loginFailures, rateKey, nowMs, RATE_LIMIT_MAX_FAILURES) ||
      isRateLimited(ipLoginFailures, ip, nowMs, RATE_LIMIT_MAX_FAILURES_PER_IP)
    ) {
      throw new HttpError(429, 'Too many login attempts. Try again later.', 'too_many_attempts');
    }

    const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    const compared = await bcrypt.compare(body.data.password, user?.passwordHash ?? DUMMY_HASH);
    const ws = user
      ? await db
          .selectFrom('workspaces')
          .select(['id'])
          .where('ownerUserId', '=', user.id)
          .executeTakeFirst()
      : undefined;

    if (!user || !user.passwordHash || !compared || !ws) {
      recordLoginFailure(loginFailures, rateKey, nowMs);
      recordLoginFailure(ipLoginFailures, ip, nowMs);
      // Audit only failures whose email matches an existing user. Unknown
      // emails are unauthenticated attacker-controlled input: auditing them
      // would let anyone grow the audit log without bound and inject
      // arbitrary strings (fake emails) into the owner's audit trail.
      if (user) {
        // Audit to the matched user's workspace, else the owner workspace —
        // the email goes in metadata only, never in the summary.
        const auditWorkspaceId = ws?.id ?? (await resolveOwner())?.workspaceId;
        if (auditWorkspaceId) {
          await audit.log({
            workspaceId: auditWorkspaceId,
            userId: user.id,
            eventType: 'auth.login_failed',
            actor: 'system',
            summary: 'Failed login attempt',
            metadata: { reason: 'bad_credentials', email },
          });
        }
      }
      throw invalidCredentials();
    }

    loginFailures.delete(rateKey);
    const now = nowIso();
    await db
      .updateTable('users')
      .set({ lastLoginAt: now, updatedAt: now })
      .where('id', '=', user.id)
      .execute();
    const { token } = await sessions.create(user.id, ws.id, requestMeta(request));
    setSessionCookie(reply, config, token);
    await audit.log({
      workspaceId: ws.id,
      userId: user.id,
      eventType: 'auth.login',
      actor: 'user',
      summary: `${user.email} logged in`,
      metadata: { method: 'password' },
    });
    return { user: sanitizeUser({ ...user, lastLoginAt: now, updatedAt: now }) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.sessionId) {
      await sessions.revoke(request.sessionId, request.userId);
    }
    clearSessionCookie(reply, config);
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

  app.get('/api/auth/methods', async () => {
    const env = config.env;
    const oauthProviders: string[] = [];
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) oauthProviders.push('google');
    if (env.FACEBOOK_CLIENT_ID && env.FACEBOOK_CLIENT_SECRET) oauthProviders.push('facebook');
    if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
      oauthProviders.push('apple');
    }
    return {
      authMode: env.DONNA_AUTH_MODE,
      signupEnabled: env.DONNA_AUTH_MODE === 'password' && env.DONNA_ALLOW_SIGNUP,
      oauthProviders,
    };
  });

  app.post('/api/auth/password', async (request) => {
    const body = z
      .object({ currentPassword: z.string().optional(), newPassword: z.string().min(1) })
      .safeParse(request.body);
    if (!body.success) throw badRequest('New password is required');

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', request.userId)
      .executeTakeFirst();
    if (!user) throw unauthorized();

    if (user.passwordHash) {
      if (!body.data.currentPassword) throw badRequest('Current password is required');
      const ok = await bcrypt.compare(body.data.currentPassword, user.passwordHash);
      if (!ok) throw new HttpError(401, 'Current password is incorrect', 'invalid_credentials');
    }

    const policyProblem = validatePassword(body.data.newPassword, user.email);
    if (policyProblem) throw badRequest(policyProblem, 'weak_password');

    const passwordHash = await bcrypt.hash(body.data.newPassword, 10);
    await db
      .updateTable('users')
      .set({ passwordHash, updatedAt: nowIso() })
      .where('id', '=', user.id)
      .execute();
    await sessions.revokeAllForUser(user.id, request.sessionId);
    await audit.log({
      workspaceId: request.workspaceId,
      userId: user.id,
      eventType: 'auth.password_changed',
      actor: 'user',
      summary: 'Password changed; other sessions revoked',
    });
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (request) => {
    const items = (await sessions.listForUser(request.userId)).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      userAgent: s.userAgent,
      ip: s.ip,
      current: s.id === request.sessionId,
    }));
    return { items };
  });

  app.delete('/api/auth/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const revoked = await sessions.revoke(id, request.userId);
    if (!revoked) throw notFound('Session not found');
    await audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'auth.session_revoked',
      actor: 'user',
      summary: 'Session revoked',
      metadata: { sessionId: id },
    });
    return { ok: true };
  });

  app.delete('/api/auth/sessions', async (request) => {
    const revoked = await sessions.revokeAllForUser(request.userId, request.sessionId);
    await audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'auth.session_revoked',
      actor: 'user',
      summary: `Revoked ${revoked} other session(s)`,
      metadata: { revoked },
    });
    return { ok: true, revoked };
  });

  app.get('/api/me', async (request) => {
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', request.userId)
      .executeTakeFirst();
    const workspace = await db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!user || !workspace) throw unauthorized();
    return { user: sanitizeUser(user), workspace, authMode: config.env.DONNA_AUTH_MODE };
  });

  app.patch('/api/me', async (request) => {
    const body = z
      .object({ name: z.string().min(1).max(120).optional(), email: z.string().email().optional() })
      .safeParse(request.body);
    if (!body.success) throw badRequest('Invalid profile fields');
    const patch: Record<string, string> = { updatedAt: nowIso() };
    if (body.data.name) patch.name = body.data.name;
    if (body.data.email) patch.email = body.data.email.toLowerCase();
    try {
      await db.updateTable('users').set(patch).where('id', '=', request.userId).execute();
    } catch (err) {
      if (isUniqueViolation(err)) throw badRequest('Email is already in use', 'email_in_use');
      throw err;
    }
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', request.userId)
      .executeTakeFirstOrThrow();
    return { user: sanitizeUser(user) };
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
      emailVerified: 0,
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
