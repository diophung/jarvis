import { createHmac } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { Db } from '@jarvis/db';
import fastify, { type FastifyInstance } from 'fastify';
import { decodeProtectedHeader, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import { HttpError } from '../lib/http-errors.js';
import type { OauthStatePayload } from '../lib/oauth.js';
import { createAuditService } from '../services/audit.js';
import { createSessionsService, type SessionsService } from '../services/sessions.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerAuthOauthRoutes, webRedirect } from './auth-oauth.js';

const COOKIE_SECRET = 'test-secret';
const STATE_COOKIE = 'jarvis_oauth_login';
const SESSION_COOKIE = 'jarvis_session';

/**
 * jose's createRemoteJWKSet fetches over node:http(s) (not global fetch), so
 * remote JWKS resolution is mocked with createLocalJWKSet backed by per-URL
 * key sets the tests control. Everything else in 'jose' stays real.
 */
const jwksStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: (url: URL) => async (protectedHeader: unknown, token: unknown) => {
      const jwks = jwksStore.get(url.href);
      if (!jwks) throw new Error(`no test JWKS registered for ${url.href}`);
      return actual.createLocalJWKSet(jwks as Parameters<typeof actual.createLocalJWKSet>[0])(
        protectedHeader as never,
        token as never,
      );
    },
  };
});

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let googleKeys: KeyPair;
let appleServerKeys: KeyPair;
let applePrivateKeyPem: string;

beforeAll(async () => {
  googleKeys = await generateKeyPair('RS256', { extractable: true });
  appleServerKeys = await generateKeyPair('ES256', { extractable: true });
  applePrivateKeyPem = await exportPKCS8((await generateKeyPair('ES256', { extractable: true })).privateKey);
  jwksStore.set('https://www.googleapis.com/oauth2/v3/certs', {
    keys: [{ ...(await exportJWK(googleKeys.publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' }],
  });
  jwksStore.set('https://appleid.apple.com/auth/keys', {
    keys: [{ ...(await exportJWK(appleServerKeys.publicKey)), kid: 'a1', alg: 'ES256', use: 'sig' }],
  });
});

function makeConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    JARVIS_AUTH_MODE: 'password',
    JARVIS_ALLOW_SIGNUP: 'true',
    JARVIS_WEB_ORIGIN: 'http://web.test',
    JARVIS_PUBLIC_URL: 'http://api.test',
    JARVIS_PUBLIC_DIR: undefined,
    JARVIS_COOKIE_SECURE: 'false',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    FACEBOOK_CLIENT_ID: 'fb-client-id',
    FACEBOOK_CLIENT_SECRET: 'fb-secret',
    APPLE_CLIENT_ID: 'com.jarvis.test',
    APPLE_TEAM_ID: 'TEAMID1234',
    APPLE_KEY_ID: 'KEYID12345',
    APPLE_PRIVATE_KEY: applePrivateKeyPem,
    ...overrides,
  });
}

// -- fetch mock ---------------------------------------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Response | null;
let fetchHandlers: FetchHandler[] = [];
let fetchCalls: { url: string; init?: RequestInit }[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchHandlers = [];
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      for (const handler of fetchHandlers) {
        const res = handler(url, init);
        if (res) return res;
      }
      throw new Error(`unexpected fetch in test: ${url.split('?')[0]}`);
    }),
  );
});

// -- app harness ---------------------------------------------------------------

interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  sessions: SessionsService;
  /** Make subsequent JSON requests act as this authed user (global-hook stub). */
  actAs(userId: string, workspaceId: string): void;
}

let openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.map((app) => app.close()));
  openApps = [];
  vi.unstubAllGlobals();
});

async function buildApp(configOverrides: Partial<Record<string, string>> = {}): Promise<TestApp> {
  const db = await createTestDb();
  const config = makeConfig(configOverrides);
  const audit = createAuditService({ db });
  const sessions = createSessionsService(db);

  const app = fastify();
  await app.register(fastifyCookie, { secret: COOKIE_SECRET });
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      return;
    }
    reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.decorateRequest('sessionId', '');
  let actor: { userId: string; workspaceId: string } | null = null;
  app.addHook('onRequest', async (request) => {
    if (actor) {
      request.userId = actor.userId;
      request.workspaceId = actor.workspaceId;
    }
  });
  registerAuthOauthRoutes(app, { db, config, audit, sessions });
  await app.ready();
  openApps.push(app);
  return {
    app,
    db,
    config,
    sessions,
    actAs(userId, workspaceId) {
      actor = { userId, workspaceId };
    },
  };
}

// -- flow helpers ---------------------------------------------------------------

interface StartedFlow {
  location: URL;
  state: string;
  nonce: string | null;
  cookieValue: string;
  payload: OauthStatePayload;
}

function decodeStateCookie(value: string): OauthStatePayload {
  const decoded = decodeURIComponent(value);
  return JSON.parse(decoded.slice(0, decoded.lastIndexOf('.'))) as OauthStatePayload;
}

async function startFlow(
  app: FastifyInstance,
  provider: string,
  query = '',
  cookies: Record<string, string> = {},
): Promise<StartedFlow> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/auth/oauth/${provider}/start${query}`,
    cookies,
  });
  expect(res.statusCode).toBe(302);
  const location = new URL(String(res.headers.location));
  const stateCookie = res.cookies.find((c) => c.name === STATE_COOKIE);
  expect(stateCookie).toBeDefined();
  return {
    location,
    state: location.searchParams.get('state') ?? '',
    nonce: location.searchParams.get('nonce'),
    cookieValue: stateCookie!.value,
    payload: decodeStateCookie(stateCookie!.value),
  };
}

async function signGoogleIdToken(claims: Record<string, unknown>, sub: string): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
    .setSubject(sub)
    .setIssuer('https://accounts.google.com')
    .setAudience('google-client-id')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(googleKeys.privateKey);
}

function serveGoogleToken(idToken: string): void {
  // unshift: the newest token response wins when a test runs several logins.
  fetchHandlers.unshift((url) =>
    url.startsWith('https://oauth2.googleapis.com/token')
      ? jsonResponse({ id_token: idToken, access_token: 'ya29.x', token_type: 'Bearer' })
      : null,
  );
}

/** Run a full google login (start + callback) and return the callback response. */
async function googleLogin(
  harness: TestApp,
  opts: {
    sub: string;
    email?: string | null;
    emailVerified?: boolean;
    name?: string;
    nonceOverride?: string;
    startQuery?: string;
    extraCookies?: Record<string, string>;
  },
) {
  const flow = await startFlow(harness.app, 'google', opts.startQuery ?? '', opts.extraCookies ?? {});
  const claims: Record<string, unknown> = { nonce: opts.nonceOverride ?? flow.nonce };
  if (opts.email !== null) claims.email = opts.email ?? 'ada@example.com';
  claims.email_verified = opts.emailVerified ?? true;
  if (opts.name) claims.name = opts.name;
  serveGoogleToken(await signGoogleIdToken(claims, opts.sub));
  const res = await harness.app.inject({
    method: 'GET',
    url: `/api/auth/oauth/google/callback?code=auth-code-1&state=${encodeURIComponent(flow.state)}`,
    cookies: { [STATE_COOKIE]: flow.cookieValue, ...(opts.extraCookies ?? {}) },
  });
  return { res, flow };
}

async function auditEvents(db: Db, eventType: string) {
  return db.selectFrom('auditLogs').selectAll().where('eventType', '=', eventType).execute();
}

// ---------------------------------------------------------------------------

describe('GET /api/auth/oauth/:provider/start', () => {
  it('rejects unknown providers with 400', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/github/start' });
    expect(res.statusCode).toBe(400);
  });

  it("rejects providers without credentials with 'not_configured'", async () => {
    const { app } = await buildApp({
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    });
    const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/google/start' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_configured');
  });

  it('google: 302 to the consent screen with PKCE S256 + nonce and a Lax state cookie', async () => {
    const { app } = await buildApp();
    const flow = await startFlow(app, 'google', '?returnTo=%2Finbox');
    expect(flow.location.origin + flow.location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(flow.location.searchParams.get('client_id')).toBe('google-client-id');
    expect(flow.location.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/auth/oauth/google/callback',
    );
    expect(flow.location.searchParams.get('scope')).toBe('openid email profile');
    expect(flow.location.searchParams.get('response_type')).toBe('code');
    expect(flow.state.length).toBeGreaterThanOrEqual(32);
    expect(flow.nonce).toBeTruthy();
    expect(flow.location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.location.searchParams.get('code_challenge')).toBeTruthy();
    // The signed cookie carries the same state + the PKCE verifier.
    expect(flow.payload.state).toBe(flow.state);
    expect(flow.payload.codeVerifier).toBeTruthy();
    expect(flow.payload.returnTo).toBe('/inbox');
    const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/google/start' });
    expect(String(res.headers['set-cookie'])).toContain('SameSite=Lax');
  });

  it('facebook: scope email,public_profile and no PKCE/nonce', async () => {
    const { app } = await buildApp();
    const flow = await startFlow(app, 'facebook');
    expect(flow.location.origin + flow.location.pathname).toBe(
      'https://www.facebook.com/v19.0/dialog/oauth',
    );
    expect(flow.location.searchParams.get('client_id')).toBe('fb-client-id');
    expect(flow.location.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/auth/oauth/facebook/callback',
    );
    expect(flow.location.searchParams.get('scope')).toBe('email,public_profile');
    expect(flow.location.searchParams.has('code_challenge')).toBe(false);
    expect(flow.location.searchParams.has('nonce')).toBe(false);
  });

  it('apple: form_post + SameSite=None Secure state cookie', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/apple/start' });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(location.searchParams.get('response_mode')).toBe('form_post');
    expect(location.searchParams.get('scope')).toBe('name email');
    expect(location.searchParams.get('nonce')).toBeTruthy();
    const header = String(res.headers['set-cookie']);
    expect(header).toContain('SameSite=None');
    expect(header).toContain('Secure');
  });

  it('link=1 requires a valid session and binds the state to that user', async () => {
    const harness = await buildApp();
    const denied = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/oauth/google/start?link=1',
    });
    expect(denied.statusCode).toBe(401);

    const { userId, workspaceId } = await seedWorkspace(harness.db);
    const { token } = await harness.sessions.create(userId, workspaceId);
    const flow = await startFlow(harness.app, 'google', '?link=1', {
      [SESSION_COOKIE]: fastifyCookie.sign(token, COOKIE_SECRET),
    });
    expect(flow.payload.intent).toBe('link');
    expect(flow.payload.userId).toBe(userId);
    expect(flow.payload.returnTo).toBe('/settings');
  });
});

describe('OAuth callback — failure paths', () => {
  it('redirects provider denials to /signin?error=oauth_denied', async () => {
    const { app } = await buildApp();
    const flow = await startFlow(app, 'google');
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/oauth/google/callback?error=access_denied',
      cookies: { [STATE_COOKIE]: flow.cookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/signin?error=oauth_denied');
  });

  it('redirects state mismatches (and missing state cookies) to oauth_state_mismatch', async () => {
    const { app, db } = await buildApp();
    const flow = await startFlow(app, 'google');
    const mismatched = await app.inject({
      method: 'GET',
      url: '/api/auth/oauth/google/callback?code=c&state=wrong-state-wrong-state',
      cookies: { [STATE_COOKIE]: flow.cookieValue },
    });
    expect(mismatched.headers.location).toBe('http://web.test/signin?error=oauth_state_mismatch');
    // The state cookie is single-use: it must be cleared even on failure.
    const cleared = mismatched.cookies.find((c) => c.name === STATE_COOKIE);
    expect(cleared?.value).toBe('');

    const noCookie = await app.inject({
      method: 'GET',
      url: `/api/auth/oauth/google/callback?code=c&state=${encodeURIComponent(flow.state)}`,
    });
    expect(noCookie.headers.location).toBe('http://web.test/signin?error=oauth_state_mismatch');
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(0);
  });

  it('rejects id_tokens with a mismatched nonce (oauth_failed, nothing created)', async () => {
    const harness = await buildApp();
    const { res } = await googleLogin(harness, {
      sub: 'google-sub-1',
      nonceOverride: 'replayed-nonce',
    });
    expect(res.headers.location).toBe('http://web.test/signin?error=oauth_failed');
    expect(await harness.db.selectFrom('users').select('id').execute()).toHaveLength(0);
  });

  it('uses relative redirects when the API serves the web app (JARVIS_PUBLIC_DIR)', async () => {
    const harness = await buildApp({ JARVIS_PUBLIC_DIR: '/srv/public' });
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/oauth/google/callback?code=c&state=whatever-state-whatever',
    });
    expect(res.headers.location).toBe('/signin?error=oauth_state_mismatch');
    expect(webRedirect(harness.config, '/x')).toBe('/x');
  });
});

describe('OAuth callback — google login', () => {
  it('creates user + workspace + authAccount + session and redirects to returnTo', async () => {
    const harness = await buildApp();
    const { res, flow } = await googleLogin(harness, {
      sub: 'google-sub-1',
      email: 'Ada@Example.com',
      name: 'Ada Lovelace',
      startQuery: '?returnTo=%2Finbox%3Ftab%3D1',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/inbox?tab=1');

    const user = await harness.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.email).toBe('ada@example.com');
    expect(user.name).toBe('Ada Lovelace');
    expect(user.emailVerified).toBe(1);
    expect(user.lastLoginAt).toBeTruthy();
    const workspace = await harness.db
      .selectFrom('workspaces')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(workspace.ownerUserId).toBe(user.id);
    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({
      userId: user.id,
      provider: 'google',
      providerAccountId: 'google-sub-1',
    });

    // Session cookie: signed opaque token resolving to a DB session.
    const sessionCookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatchObject({ path: '/', httpOnly: true });
    const unsigned = fastifyCookie.unsign(
      decodeURIComponent(sessionCookie!.value),
      COOKIE_SECRET,
    );
    expect(unsigned.valid).toBe(true);
    const session = await harness.sessions.validate(unsigned.value ?? '');
    expect(session?.userId).toBe(user.id);
    expect(session?.workspaceId).toBe(workspace.id);

    // PKCE: the token exchange sent the verifier from the signed state cookie.
    const tokenCall = fetchCalls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/'));
    const body = new URLSearchParams(String(tokenCall?.init?.body));
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toBe(flow.payload.codeVerifier);

    const registers = await auditEvents(harness.db, 'auth.register');
    expect(registers).toHaveLength(1);
    expect(JSON.parse(registers[0]?.metadata ?? '{}')).toMatchObject({ method: 'google' });
    const logins = await auditEvents(harness.db, 'auth.login');
    expect(logins).toHaveLength(1);
    expect(JSON.parse(logins[0]?.metadata ?? '{}')).toMatchObject({ method: 'google' });
  });

  it('reuses the existing user on a second login', async () => {
    const harness = await buildApp();
    await googleLogin(harness, { sub: 'google-sub-1' });
    fetchCalls = [];
    const { res } = await googleLogin(harness, { sub: 'google-sub-1' });
    expect(res.statusCode).toBe(302);
    expect(await harness.db.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await harness.db.selectFrom('authAccounts').select('id').execute()).toHaveLength(1);
    expect(await harness.db.selectFrom('sessions').select('id').execute()).toHaveLength(2);
    expect(await auditEvents(harness.db, 'auth.register')).toHaveLength(1);
    expect(await auditEvents(harness.db, 'auth.login')).toHaveLength(2);
  });

  it('links a verified provider email to the existing local user', async () => {
    const harness = await buildApp();
    const { userId } = await seedWorkspace(harness.db, { email: 'ada@example.com' });
    const { res } = await googleLogin(harness, { sub: 'google-sub-2', email: 'ada@example.com' });
    expect(res.statusCode).toBe(302);
    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(account.userId).toBe(userId);
    expect(await harness.db.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await auditEvents(harness.db, 'auth.oauth_linked')).toHaveLength(1);
  });

  it('refuses an UNVERIFIED email matching an existing user — and links nothing', async () => {
    const harness = await buildApp();
    await seedWorkspace(harness.db, { email: 'ada@example.com' });
    const { res } = await googleLogin(harness, {
      sub: 'google-sub-3',
      email: 'ada@example.com',
      emailVerified: false,
    });
    expect(res.headers.location).toBe('http://web.test/signin?error=email_unverified');
    expect(await harness.db.selectFrom('authAccounts').select('id').execute()).toHaveLength(0);
    const noSession = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(noSession).toBeUndefined();
  });

  it('redirects to no_email when the provider returns no usable email', async () => {
    const harness = await buildApp();
    const { res } = await googleLogin(harness, { sub: 'google-sub-4', email: null });
    expect(res.headers.location).toBe('http://web.test/signin?error=no_email');
    expect(await harness.db.selectFrom('users').select('id').execute()).toHaveLength(0);
  });

  it('redirects to signup_disabled when registration is off in password mode', async () => {
    const harness = await buildApp({ JARVIS_ALLOW_SIGNUP: 'false' });
    const { res } = await googleLogin(harness, { sub: 'google-sub-5' });
    expect(res.headers.location).toBe('http://web.test/signin?error=signup_disabled');
    expect(await harness.db.selectFrom('users').select('id').execute()).toHaveLength(0);
  });

  it('local mode: an unknown OAuth identity never provisions a new user', async () => {
    // JARVIS_ALLOW_SIGNUP defaults to true — local mode must still refuse.
    const harness = await buildApp({ JARVIS_AUTH_MODE: 'local' });
    const { res } = await googleLogin(harness, { sub: 'google-sub-6' });
    expect(res.headers.location).toBe('http://web.test/signin?error=signup_disabled');
    expect(await harness.db.selectFrom('users').select('id').execute()).toHaveLength(0);
    expect(await harness.db.selectFrom('workspaces').select('id').execute()).toHaveLength(0);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });
});

describe('OAuth callback — apple form_post', () => {
  it('accepts the urlencoded POST, parses the user field and signs the user in', async () => {
    const harness = await buildApp();
    const flow = await startFlow(harness.app, 'apple');
    const idToken = await new SignJWT({
      email: 'tim@example.com',
      email_verified: 'true', // apple sends the string form
      nonce: flow.nonce,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'a1' })
      .setSubject('apple-sub-1')
      .setIssuer('https://appleid.apple.com')
      .setAudience('com.jarvis.test')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(appleServerKeys.privateKey);
    fetchHandlers.push((url) =>
      url.startsWith('https://appleid.apple.com/auth/token')
        ? jsonResponse({ id_token: idToken, access_token: 'apple-at' })
        : null,
    );

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/oauth/apple/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        code: 'apple-code-1',
        state: flow.state,
        user: JSON.stringify({ name: { firstName: 'Tim', lastName: 'Apple' } }),
      }).toString(),
      cookies: { [STATE_COOKIE]: flow.cookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/');

    const user = await harness.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.name).toBe('Tim Apple');
    expect(user.email).toBe('tim@example.com');
    expect(user.emailVerified).toBe(1);
    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({
      provider: 'apple',
      providerAccountId: 'apple-sub-1',
      displayName: 'Tim Apple',
      emailVerified: 1,
    });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeDefined();

    // client_secret sent to Apple is a short-lived ES256 JWT with our key id.
    const tokenCall = fetchCalls.find((c) => c.url.startsWith('https://appleid.apple.com/'));
    const body = new URLSearchParams(String(tokenCall?.init?.body));
    const clientSecret = body.get('client_secret') ?? '';
    expect(clientSecret.split('.')).toHaveLength(3);
    expect(decodeProtectedHeader(clientSecret)).toMatchObject({ alg: 'ES256', kid: 'KEYID12345' });
  });
});

describe('OAuth callback — facebook', () => {
  it('exchanges the code, calls /me with an appsecret_proof and signs the user in', async () => {
    const harness = await buildApp();
    const flow = await startFlow(harness.app, 'facebook');
    fetchHandlers.push((url) =>
      url.startsWith('https://graph.facebook.com/v19.0/oauth/access_token')
        ? jsonResponse({ access_token: 'fb-at-1' })
        : null,
    );
    fetchHandlers.push((url) =>
      url.startsWith('https://graph.facebook.com/v19.0/me')
        ? jsonResponse({
            id: 'fb-123',
            name: 'Grace Hopper',
            email: 'Grace@Example.com',
            picture: { data: { url: 'https://pic.example/grace.png' } },
          })
        : null,
    );

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/auth/oauth/facebook/callback?code=fb-code&state=${encodeURIComponent(flow.state)}`,
      cookies: { [STATE_COOKIE]: flow.cookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/');

    const meCall = fetchCalls.find((c) => c.url.includes('/me'));
    const meUrl = new URL(meCall?.url ?? '');
    expect(meUrl.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', 'fb-secret').update('fb-at-1').digest('hex'),
    );
    expect(meUrl.searchParams.get('fields')).toBe('id,name,email,picture.width(256)');

    const user = await harness.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.email).toBe('grace@example.com');
    expect(user.avatarUrl).toBe('https://pic.example/grace.png');
    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(account.providerAccountId).toBe('fb-123');
  });
});

describe('OAuth callback — link intent', () => {
  async function linkSetup(harness: TestApp) {
    const { userId, workspaceId } = await seedWorkspace(harness.db);
    const { token } = await harness.sessions.create(userId, workspaceId);
    const sessionCookie = fastifyCookie.sign(token, COOKIE_SECRET);
    return { userId, workspaceId, sessionCookie };
  }

  it('attaches the identity to the logged-in user and redirects to /settings', async () => {
    const harness = await buildApp();
    const { userId, sessionCookie } = await linkSetup(harness);
    const { res } = await googleLogin(harness, {
      sub: 'google-sub-7',
      email: 'other-google@example.com',
      startQuery: '?link=1',
      extraCookies: { [SESSION_COOKIE]: sessionCookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/settings');

    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(account.userId).toBe(userId);
    // No second user, no second session — the existing session keeps working.
    expect(await harness.db.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await harness.db.selectFrom('sessions').select('id').execute()).toHaveLength(1);
    expect(await auditEvents(harness.db, 'auth.oauth_linked')).toHaveLength(1);
    expect(await auditEvents(harness.db, 'auth.login')).toHaveLength(0);
  });

  it('fails with already_linked back on /settings (not the /signin dead end)', async () => {
    const harness = await buildApp();
    await googleLogin(harness, { sub: 'google-sub-8', email: 'first@example.com' });
    fetchCalls = [];
    const { sessionCookie } = await linkSetup(harness);
    const { res } = await googleLogin(harness, {
      sub: 'google-sub-8',
      email: 'first@example.com',
      startQuery: '?link=1',
      extraCookies: { [SESSION_COOKIE]: sessionCookie },
    });
    // The user still has a live session: link failures return to the page
    // they linked from with ?linkError=, never to /signin.
    expect(res.headers.location).toBe('http://web.test/settings?linkError=already_linked');
    expect(await harness.db.selectFrom('authAccounts').select('id').execute()).toHaveLength(1);
  });

  it('link failures honor the validated returnTo from the start leg', async () => {
    const harness = await buildApp();
    await googleLogin(harness, { sub: 'google-sub-9', email: 'first@example.com' });
    fetchCalls = [];
    const { sessionCookie } = await linkSetup(harness);
    const { res } = await googleLogin(harness, {
      sub: 'google-sub-9',
      email: 'first@example.com',
      startQuery: `?link=1&returnTo=${encodeURIComponent('/settings/security')}`,
      extraCookies: { [SESSION_COOKIE]: sessionCookie },
    });
    expect(res.headers.location).toBe(
      'http://web.test/settings/security?linkError=already_linked',
    );
  });

  it('fails when the session cookie is missing on the callback leg', async () => {
    const harness = await buildApp();
    const { sessionCookie } = await linkSetup(harness);
    // Start the link flow as the logged-in user, but call back without the
    // session cookie: the link must NOT be applied.
    const flow = await startFlow(harness.app, 'google', '?link=1', {
      [SESSION_COOKIE]: sessionCookie,
    });
    serveGoogleToken(
      await signGoogleIdToken(
        { nonce: flow.nonce, email: 'x@example.com', email_verified: true },
        'google-sub-10',
      ),
    );
    const noSession = await harness.app.inject({
      method: 'GET',
      url: `/api/auth/oauth/google/callback?code=c&state=${encodeURIComponent(flow.state)}`,
      cookies: { [STATE_COOKIE]: flow.cookieValue },
    });
    expect(noSession.headers.location).toBe('http://web.test/signin?error=oauth_failed');
    expect(await harness.db.selectFrom('authAccounts').select('id').execute()).toHaveLength(0);
  });
});

describe('linked accounts JSON endpoints', () => {
  it('GET /api/auth/accounts lists the linked identities without any token material', async () => {
    const harness = await buildApp();
    await googleLogin(harness, { sub: 'google-sub-1', name: 'Ada Lovelace' });
    const user = await harness.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    const workspace = await harness.db
      .selectFrom('workspaces')
      .selectAll()
      .executeTakeFirstOrThrow();
    harness.actAs(user.id, workspace.id);

    const res = await harness.app.inject({ method: 'GET', url: '/api/auth/accounts' });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      provider: 'google',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      emailVerified: true,
    });
    expect(Object.keys(items[0]).sort()).toEqual([
      'avatarUrl',
      'createdAt',
      'displayName',
      'email',
      'emailVerified',
      'id',
      'lastLoginAt',
      'provider',
    ]);
  });

  it('requires auth for the JSON endpoints', async () => {
    const harness = await buildApp();
    expect((await harness.app.inject({ method: 'GET', url: '/api/auth/accounts' })).statusCode).toBe(
      401,
    );
    expect(
      (await harness.app.inject({ method: 'DELETE', url: '/api/auth/accounts/aac_x' })).statusCode,
    ).toBe(401);
  });

  it('refuses to unlink the last sign-in method of a password-less user', async () => {
    const harness = await buildApp();
    await googleLogin(harness, { sub: 'google-sub-1' });
    const user = await harness.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    const workspace = await harness.db
      .selectFrom('workspaces')
      .selectAll()
      .executeTakeFirstOrThrow();
    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    harness.actAs(user.id, workspace.id);

    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/auth/accounts/${account.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('last_login_method');
    expect(await harness.db.selectFrom('authAccounts').select('id').execute()).toHaveLength(1);
  });

  it('unlinks (and audits) once the user has a password to fall back on', async () => {
    const harness = await buildApp();
    await googleLogin(harness, { sub: 'google-sub-1' });
    const user = await harness.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    const workspace = await harness.db
      .selectFrom('workspaces')
      .selectAll()
      .executeTakeFirstOrThrow();
    await harness.db
      .updateTable('users')
      .set({ passwordHash: 'bcrypt-hash' })
      .where('id', '=', user.id)
      .execute();
    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    harness.actAs(user.id, workspace.id);

    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/auth/accounts/${account.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await harness.db.selectFrom('authAccounts').select('id').execute()).toHaveLength(0);
    expect(await auditEvents(harness.db, 'auth.oauth_unlinked')).toHaveLength(1);
  });

  it("404s when unlinking another user's account", async () => {
    const harness = await buildApp();
    await googleLogin(harness, { sub: 'google-sub-1' });
    const account = await harness.db
      .selectFrom('authAccounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    const { userId: stranger, workspaceId } = await seedWorkspace(harness.db, {
      email: 'stranger@example.com',
    });
    harness.actAs(stranger, workspaceId);

    const res = await harness.app.inject({
      method: 'DELETE',
      url: `/api/auth/accounts/${account.id}`,
    });
    expect(res.statusCode).toBe(404);
    expect(await harness.db.selectFrom('authAccounts').select('id').execute()).toHaveLength(1);
  });
});
