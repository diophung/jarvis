import cookie from '@fastify/cookie';
import type { Db } from '@donna/db';
import bcrypt from 'bcryptjs';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAuth, resetLoginRateLimiter, validatePassword } from './auth.js';
import { loadConfig } from './config.js';
import { HttpError } from './lib/http-errors.js';
import { createAuditService } from './services/audit.js';
import { createSessionsService } from './services/sessions.js';
import { createTestDb, seedWorkspace } from './test/helpers.js';

let db: Db;
let userId: string;
let workspaceId: string;
let userEmail: string;
const openApps: FastifyInstance[] = [];

const PASSWORD = 'hunter2-hunter2';

async function buildApp(env: Partial<Record<string, string>> = {}): Promise<FastifyInstance> {
  const config = loadConfig({
    // Never inherit provider creds from the host environment.
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    FACEBOOK_CLIENT_ID: undefined,
    FACEBOOK_CLIENT_SECRET: undefined,
    APPLE_CLIENT_ID: undefined,
    APPLE_TEAM_ID: undefined,
    APPLE_KEY_ID: undefined,
    APPLE_PRIVATE_KEY: undefined,
    ...env,
  });
  const app = fastify();
  await app.register(cookie, { secret: config.env.DONNA_SECRET });
  // Mirror app.ts so HttpError maps to the contract error shape.
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      return;
    }
    reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });
  registerAuth(app, {
    db,
    config,
    audit: createAuditService({ db }),
    sessions: createSessionsService(db),
  });
  await app.ready();
  openApps.push(app);
  return app;
}

function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
}

/** Raw signed cookie value straight from Set-Cookie (no decode/encode drift). */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const match = setCookieHeader(res).match(/donna_session=([^;]+)/);
  return match?.[1] ?? '';
}

function asCookieHeader(value: string): { cookie: string } {
  return { cookie: `donna_session=${value}` };
}

async function setPassword(password = PASSWORD): Promise<void> {
  const passwordHash = await bcrypt.hash(password, 4);
  await db.updateTable('users').set({ passwordHash }).where('id', '=', userId).execute();
}

async function loginCookie(app: FastifyInstance, password = PASSWORD): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: userEmail, password },
  });
  expect(res.statusCode).toBe(200);
  return sessionCookie(res);
}

async function auditRows(eventType: string): Promise<Array<Record<string, unknown>>> {
  return db.selectFrom('auditLogs').selectAll().where('eventType', '=', eventType).execute();
}

beforeEach(async () => {
  resetLoginRateLimiter();
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  userId = seeded.userId;
  workspaceId = seeded.workspaceId;
  const row = await db
    .selectFrom('users')
    .select(['email'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  userEmail = row.email;
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
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

    const secureApp = await buildApp({ DONNA_AUTH_MODE: 'local', DONNA_COOKIE_SECURE: 'true' });
    const secure = await secureApp.inject({ method: 'GET', url: '/api/me' });
    expect(secure.statusCode).toBe(200);
    expect(setCookieHeader(secure)).toContain('donna_session');
    expect(setCookieHeader(secure)).toMatch(/;\s*Secure/i);
  });

  it('password login sets Secure when DONNA_COOKIE_SECURE=true', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password', DONNA_COOKIE_SECURE: 'true' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: userEmail, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(setCookieHeader(res)).toContain('donna_session');
    expect(setCookieHeader(res)).toMatch(/;\s*Secure/i);
  });
});

describe('password policy', () => {
  it('enforces length, email mismatch and the common-password denylist', () => {
    expect(validatePassword('short', 'a@b.com')).toMatch(/at least 10/);
    expect(validatePassword('x'.repeat(201), 'a@b.com')).toMatch(/at most 200/);
    expect(validatePassword('Same@Email.com', 'same@email.com')).toMatch(/different from your email/);
    expect(validatePassword('password123', 'a@b.com')).toMatch(/too common/);
    expect(validatePassword('QWERTY123456', 'a@b.com')).toMatch(/too common/);
    expect(validatePassword('a-perfectly-fine-passphrase', 'a@b.com')).toBeNull();
  });
});

describe('POST /api/auth/register', () => {
  const env = { DONNA_AUTH_MODE: 'password', DONNA_ALLOW_SIGNUP: 'true' };

  it('creates a user + workspace, sets a session cookie, returns a sanitized user', async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'New.Person@Example.com', name: 'New Person', password: 'a-long-enough-pass' },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)).not.toBe('');
    const { user } = res.json() as { user: Record<string, unknown> };
    expect(user.email).toBe('new.person@example.com');
    expect(user.hasPassword).toBe(true);
    expect(user.emailVerified).toBe(false);
    expect(user).not.toHaveProperty('passwordHash');

    // The cookie is a working session.
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: asCookieHeader(sessionCookie(res)),
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { user: { id: string }; workspace: { name: string } };
    expect(meBody.user.id).toBe(user.id);
    expect(meBody.workspace.name).toBe("New Person's Workspace");

    expect(await auditRows('auth.register')).toHaveLength(1);
  });

  it('returns a generic 400 for duplicate emails (no account-existence leak)', async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: userEmail.toUpperCase(), name: 'Imposter', password: 'a-long-enough-pass' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: { code: string; message: string } };
    expect(error.code).toBe('registration_failed');
    expect(error.message).not.toMatch(/exist|taken|already|duplicate/i);
  });

  it('rejects weak passwords', async () => {
    const app = await buildApp(env);
    for (const password of ['short', 'password123', 'new@user.example']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'new@user.example', name: 'New', password },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('weak_password');
    }
  });

  it('403s when signup is disabled or auth mode is local', async () => {
    const payload = { email: 'new@user.example', name: 'New', password: 'a-long-enough-pass' };
    const disabled = await buildApp({ DONNA_AUTH_MODE: 'password', DONNA_ALLOW_SIGNUP: 'false' });
    expect(
      (await disabled.inject({ method: 'POST', url: '/api/auth/register', payload })).statusCode,
    ).toBe(403);
    const local = await buildApp({ DONNA_AUTH_MODE: 'local', DONNA_ALLOW_SIGNUP: 'true' });
    expect(
      (await local.inject({ method: 'POST', url: '/api/auth/register', payload })).statusCode,
    ).toBe(403);
  });
});

describe('POST /api/auth/login', () => {
  it('sets a session cookie, updates lastLoginAt, audits and sanitizes the user', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: userEmail, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)).not.toBe('');
    const { user } = res.json() as { user: Record<string, unknown> };
    expect(user.hasPassword).toBe(true);
    expect(typeof user.lastLoginAt).toBe('string');
    expect(user).not.toHaveProperty('passwordHash');

    const logins = await auditRows('auth.login');
    expect(logins).toHaveLength(1);
    expect(JSON.parse(String(logins[0]?.metadata))).toMatchObject({ method: 'password' });

    const row = await db
      .selectFrom('users')
      .select(['lastLoginAt'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.lastLoginAt).not.toBeNull();
  });

  it('returns the same generic 401 for unknown email, wrong password and passwordless users', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    await seedWorkspace(db, { email: 'nopass@example.com' }); // passwordless user

    const attempts = [
      { email: 'ghost@example.com', password: 'whatever-pass' },
      { email: userEmail, password: 'wrong-password-x' },
      { email: 'nopass@example.com', password: 'whatever-pass' },
    ];
    for (const payload of attempts) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).toBe(401);
      const { error } = res.json() as { error: { code: string; message: string } };
      expect(error.code).toBe('invalid_credentials');
      expect(error.message).toBe('Invalid email or password');
    }

    // Failures are audited with the email in metadata, never in the summary.
    const failures = await auditRows('auth.login_failed');
    expect(failures).toHaveLength(3);
    for (const rowFail of failures) {
      expect(String(rowFail.summary)).not.toContain('@');
      const meta = JSON.parse(String(rowFail.metadata)) as { reason: string; email: string };
      expect(meta.reason).toBe('bad_credentials');
      expect(meta.email).toContain('@');
    }
  });

  it('rate limits after 5 failures for the same email+ip, even with the right password', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: userEmail, password: 'wrong-password-x' },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: userEmail, password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('too_many_attempts');

    // A different email|ip key is unaffected.
    await seedWorkspace(db, { email: 'other@example.com' });
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'other@example.com', password: 'whatever-pass' },
    });
    expect(other.statusCode).toBe(401);
  });

  it('clears the failure counter on success', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: userEmail, password: 'wrong-password-x' },
      });
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: userEmail, password: PASSWORD },
        })
      ).statusCode,
    ).toBe(200);
    // Counter restarted: another failure is a 401, not a 429.
    const after = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: userEmail, password: 'wrong-password-x' },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the DB session so the cookie stops working in password mode', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const token = await loginCookie(app);

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: asCookieHeader(token),
    });
    expect(out.statusCode).toBe(200);
    expect((out.json() as { ok: boolean }).ok).toBe(true);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(token) });
    expect(me.statusCode).toBe(401);
    expect(await auditRows('auth.logout')).toHaveLength(1);
  });

  it('still returns 200 when the session row is already gone (local mode)', async () => {
    const app = await buildApp({ DONNA_AUTH_MODE: 'local' });
    await db.deleteFrom('sessions').execute();
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(200);
  });
});

describe('session expiry', () => {
  it('validate() returns null for an expired session and deletes the row', async () => {
    const sessions = createSessionsService(db);
    const { token, session } = await sessions.create(userId, workspaceId);
    await db
      .updateTable('sessions')
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', session.id)
      .execute();
    expect(await sessions.validate(token)).toBeNull();
    const rows = await db.selectFrom('sessions').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('an expired cookie is a 401 in password mode', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const token = await loginCookie(app);
    await db
      .updateTable('sessions')
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .execute();
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(token) });
    expect(me.statusCode).toBe(401);
  });
});

describe('GET /api/auth/methods', () => {
  it('is public and reports mode + signup', async () => {
    const app = await buildApp({ DONNA_AUTH_MODE: 'password', DONNA_ALLOW_SIGNUP: 'true' });
    const res = await app.inject({ method: 'GET', url: '/api/auth/methods' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authMode: 'password', signupEnabled: true, oauthProviders: [] });
  });

  it('signupEnabled is false in local mode and when DONNA_ALLOW_SIGNUP=false', async () => {
    const local = await buildApp({ DONNA_AUTH_MODE: 'local', DONNA_ALLOW_SIGNUP: 'true' });
    expect(
      ((await local.inject({ method: 'GET', url: '/api/auth/methods' })).json() as {
        signupEnabled: boolean;
      }).signupEnabled,
    ).toBe(false);
    const off = await buildApp({ DONNA_AUTH_MODE: 'password', DONNA_ALLOW_SIGNUP: 'false' });
    expect(
      ((await off.inject({ method: 'GET', url: '/api/auth/methods' })).json() as {
        signupEnabled: boolean;
      }).signupEnabled,
    ).toBe(false);
  });

  it('lists only fully-configured OAuth providers', async () => {
    const partial = await buildApp({
      DONNA_AUTH_MODE: 'password',
      GOOGLE_CLIENT_ID: 'gid',
      FACEBOOK_CLIENT_ID: 'fid',
      FACEBOOK_CLIENT_SECRET: 'fsecret',
      APPLE_CLIENT_ID: 'aid',
      APPLE_TEAM_ID: 'team',
      APPLE_KEY_ID: 'key',
      // GOOGLE_CLIENT_SECRET and APPLE_PRIVATE_KEY intentionally missing.
    });
    const res = await partial.inject({ method: 'GET', url: '/api/auth/methods' });
    expect((res.json() as { oauthProviders: string[] }).oauthProviders).toEqual(['facebook']);

    const full = await buildApp({
      DONNA_AUTH_MODE: 'password',
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      FACEBOOK_CLIENT_ID: 'fid',
      FACEBOOK_CLIENT_SECRET: 'fsecret',
      APPLE_CLIENT_ID: 'aid',
      APPLE_TEAM_ID: 'team',
      APPLE_KEY_ID: 'key',
      APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    });
    const all = await full.inject({ method: 'GET', url: '/api/auth/methods' });
    expect((all.json() as { oauthProviders: string[] }).oauthProviders).toEqual([
      'google',
      'facebook',
      'apple',
    ]);
  });
});

describe('POST /api/auth/password', () => {
  it('rejects a wrong current password with 401 invalid_credentials', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const token = await loginCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: asCookieHeader(token),
      payload: { currentPassword: 'totally-wrong-pass', newPassword: 'a-brand-new-passphrase' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_credentials');
  });

  it('requires currentPassword when one is set and validates the new password', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const token = await loginCookie(app);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: asCookieHeader(token),
      payload: { newPassword: 'a-brand-new-passphrase' },
    });
    expect(missing.statusCode).toBe(400);
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: asCookieHeader(token),
      payload: { currentPassword: PASSWORD, newPassword: 'password123' },
    });
    expect(weak.statusCode).toBe(400);
    expect((weak.json() as { error: { code: string } }).error.code).toBe('weak_password');
  });

  it('changes the password and revokes all other sessions', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const keep = await loginCookie(app);
    const other = await loginCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: asCookieHeader(keep),
      payload: { currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase' },
    });
    expect(res.statusCode).toBe(200);

    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(keep) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(other) }))
        .statusCode,
    ).toBe(401);

    // Old password no longer works; the new one does.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: userEmail, password: PASSWORD },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: userEmail, password: 'a-brand-new-passphrase' },
        })
      ).statusCode,
    ).toBe(200);
    expect(await auditRows('auth.password_changed')).toHaveLength(1);
  });

  it('lets a passwordless user set a password without currentPassword (local mode)', async () => {
    const app = await buildApp({ DONNA_AUTH_MODE: 'local' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { newPassword: 'a-brand-new-passphrase' },
    });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    expect((me.json() as { user: { hasPassword: boolean } }).user.hasPassword).toBe(true);
  });
});

describe('session management endpoints', () => {
  it('lists sessions with a current flag and no token material', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const a = await loginCookie(app);
    await loginCookie(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: asCookieHeader(a),
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<Record<string, unknown>> };
    expect(items).toHaveLength(2);
    expect(items.filter((s) => s.current)).toHaveLength(1);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ['createdAt', 'current', 'id', 'ip', 'lastSeenAt', 'userAgent'].sort(),
      );
    }
  });

  it('revokes one of my sessions by id; 404 for unknown or foreign ids', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const mine = await loginCookie(app);
    const otherCookie = await loginCookie(app);
    const list = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: asCookieHeader(mine),
    });
    const { items } = list.json() as { items: Array<{ id: string; current: boolean }> };
    const otherId = items.find((s) => !s.current)?.id as string;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${otherId}`,
      headers: asCookieHeader(mine),
    });
    expect(del.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(otherCookie) }))
        .statusCode,
    ).toBe(401);

    // Unknown id -> 404.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/auth/sessions/ses_does_not_exist',
          headers: asCookieHeader(mine),
        })
      ).statusCode,
    ).toBe(404);

    // Another user's session -> 404 (not mine to revoke).
    const stranger = await seedWorkspace(db, { email: 'stranger@example.com' });
    const sessions = createSessionsService(db);
    const { session: foreign } = await sessions.create(stranger.userId, stranger.workspaceId);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/auth/sessions/${foreign.id}`,
          headers: asCookieHeader(mine),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('revokes all sessions except the current one', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const keep = await loginCookie(app);
    const b = await loginCookie(app);
    const c = await loginCookie(app);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions',
      headers: asCookieHeader(keep),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, revoked: 2 });

    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(keep) }))
        .statusCode,
    ).toBe(200);
    for (const dead of [b, c]) {
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(dead) }))
          .statusCode,
      ).toBe(401);
    }
  });
});

describe('GET /api/me and PATCH /api/me', () => {
  it('returns a sanitized user (hasPassword, emailVerified boolean, never passwordHash)', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const token = await loginCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: asCookieHeader(token) });
    expect(res.statusCode).toBe(200);
    const { user, authMode } = res.json() as {
      user: Record<string, unknown>;
      authMode: string;
    };
    expect(authMode).toBe('password');
    expect(user.hasPassword).toBe(true);
    expect(user.emailVerified).toBe(false);
    expect(user).toHaveProperty('avatarUrl');
    expect(user).toHaveProperty('lastLoginAt');
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('PATCH /api/me updates the profile and returns a sanitized user', async () => {
    const app = await buildApp({ DONNA_AUTH_MODE: 'local' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      payload: { name: 'Renamed', email: 'Renamed@Example.com' },
    });
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as { user: Record<string, unknown> };
    expect(user.name).toBe('Renamed');
    expect(user.email).toBe('renamed@example.com');
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('PATCH /api/me rejects changing email to one already in use', async () => {
    await seedWorkspace(db, { email: 'occupied@example.com' });
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const token = await loginCookie(app);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: asCookieHeader(token),
      payload: { email: 'occupied@example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('email_in_use');
  });
});

describe('auth middleware', () => {
  it('401s on protected routes without a cookie in password mode', async () => {
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    for (const url of ['/api/me', '/api/auth/sessions', '/api/anything-else']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('leaves public paths open in password mode', async () => {
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    expect((await app.inject({ method: 'GET', url: '/api/auth/methods' })).statusCode).toBe(200);
    // No route registered here, but the middleware lets /api/auth/oauth/*
    // through: 404 from the router, not 401 from auth.
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/oauth/google/start?returnTo=/x' }))
        .statusCode,
    ).toBe(404);
  });

  it('local mode auto-login creates a real DB session and reuses it via the cookie', async () => {
    const app = await buildApp({ DONNA_AUTH_MODE: 'local' });
    const first = await app.inject({ method: 'GET', url: '/api/me' });
    expect(first.statusCode).toBe(200);
    const token = sessionCookie(first);
    expect(token).not.toBe('');
    expect(await db.selectFrom('sessions').selectAll().execute()).toHaveLength(1);

    // Subsequent request with the cookie reuses the session: no new Set-Cookie.
    const second = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: asCookieHeader(token),
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(await db.selectFrom('sessions').selectAll().execute()).toHaveLength(1);

    const { user } = second.json() as { user: Record<string, unknown> };
    expect(user.hasPassword).toBe(false);
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('the session cookie is signed: a tampered value is rejected (401 in password mode)', async () => {
    await setPassword();
    const app = await buildApp({ DONNA_AUTH_MODE: 'password' });
    const token = await loginCookie(app);
    const tampered = `${token.slice(0, -4)}AAAA`;
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: asCookieHeader(tampered),
    });
    expect(res.statusCode).toBe(401);
  });
});
