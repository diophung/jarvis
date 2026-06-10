import cookie from '@fastify/cookie';
import type { Db } from '@donna/db';
import bcrypt from 'bcryptjs';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createAuditService } from './services/audit.js';
import { createTestDb, seedWorkspace } from './test/helpers.js';

let db: Db;
let userId: string;

async function buildApp(env: Partial<Record<string, string>> = {}): Promise<FastifyInstance> {
  const config = loadConfig(env);
  const app = fastify();
  await app.register(cookie, { secret: config.env.DONNA_SECRET });
  registerAuth(app, { db, config, audit: createAuditService({ db }) });
  await app.ready();
  return app;
}

function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
}

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  userId = seeded.userId;
});

describe('config flags', () => {
  it('parses DONNA_COOKIE_SECURE (default false) and DONNA_INLINE_WORKER (default true)', () => {
    const defaults = loadConfig({ DONNA_COOKIE_SECURE: undefined, DONNA_INLINE_WORKER: undefined });
    expect(defaults.env.DONNA_COOKIE_SECURE).toBe(false);
    expect(defaults.env.DONNA_INLINE_WORKER).toBe(true);

    const flipped = loadConfig({ DONNA_COOKIE_SECURE: 'true', DONNA_INLINE_WORKER: 'false' });
    expect(flipped.env.DONNA_COOKIE_SECURE).toBe(true);
    expect(flipped.env.DONNA_INLINE_WORKER).toBe(false);
  });
});

describe('session cookie Secure attribute', () => {
  it('local-mode auto-login sets Secure only when DONNA_COOKIE_SECURE=true', async () => {
    const insecureApp = await buildApp({ DONNA_AUTH_MODE: 'local', DONNA_COOKIE_SECURE: 'false' });
    const insecure = await insecureApp.inject({ method: 'GET', url: '/api/me' });
    expect(insecure.statusCode).toBe(200);
    expect(setCookieHeader(insecure)).toContain('donna_session');
    expect(setCookieHeader(insecure)).not.toMatch(/;\s*Secure/i);
    await insecureApp.close();

    const secureApp = await buildApp({ DONNA_AUTH_MODE: 'local', DONNA_COOKIE_SECURE: 'true' });
    const secure = await secureApp.inject({ method: 'GET', url: '/api/me' });
    expect(secure.statusCode).toBe(200);
    expect(setCookieHeader(secure)).toContain('donna_session');
    expect(setCookieHeader(secure)).toMatch(/;\s*Secure/i);
    await secureApp.close();
  });

  it('password login sets Secure when DONNA_COOKIE_SECURE=true', async () => {
    const passwordHash = await bcrypt.hash('hunter2-hunter2', 4);
    await db.updateTable('users').set({ passwordHash }).where('id', '=', userId).execute();
    const user = await db
      .selectFrom('users')
      .select(['email'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    const app = await buildApp({ DONNA_AUTH_MODE: 'password', DONNA_COOKIE_SECURE: 'true' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'hunter2-hunter2' },
    });
    expect(res.statusCode).toBe(200);
    expect(setCookieHeader(res)).toContain('donna_session');
    expect(setCookieHeader(res)).toMatch(/;\s*Secure/i);
    await app.close();
  });
});
