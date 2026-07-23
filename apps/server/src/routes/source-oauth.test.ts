import cookie from '@fastify/cookie';
import { newId, nowIso, toJson, type ConnectorRun } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import type { IngestionService, TokensService } from '../context.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { HttpError } from '../lib/http-errors.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from '../services/audit.js';
import {
  registerSourceOauthRoutes,
  resetGoogleJwksCache,
  SOURCE_STATE_COOKIE,
} from './source-oauth.js';

const KEY = 'test-token-key';
const CLIENT_ID = 'test-google-client';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function testConfig(env: Record<string, unknown> = {}): AppConfig {
  return {
    env: {
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'test-google-secret',
      JARVIS_WEB_ORIGIN: 'http://web.test',
      JARVIS_COOKIE_SECURE: false,
      ...env,
    } as unknown as AppConfig['env'],
    isProdSecret: false,
    uploadsDir: '/tmp/jarvis-test-uploads',
    sqlitePath: ':memory:',
    publicUrl: 'http://api.test',
    tokenEncryptionKey: KEY,
  };
}

const stubTokens: TokensService = {
  async getGoogleAccessTokenForUser() {
    throw new Error('not used');
  },
  async refreshGoogleTokenIfNeeded() {},
  tokenSourceFor: () => ({ getAccessToken: async () => 'stub' }),
  isOauthAccount: (authRef) => authRef !== null && authRef.startsWith('oauth:'),
  async disconnectSource() {},
};

interface TestApp {
  app: FastifyInstance;
  db: Db;
  auth: { userId: string; workspaceId: string };
  syncCalls: Array<{ workspaceId: string; accountId: string; opts: unknown }>;
}

let openApps: FastifyInstance[] = [];

async function buildApp(config: AppConfig = testConfig()): Promise<TestApp> {
  const db = await createTestDb();
  const { userId, workspaceId } = await seedWorkspace(db);
  const auth = { userId, workspaceId };

  const syncCalls: TestApp['syncCalls'] = [];
  const ingestion: IngestionService = {
    async syncAccount(wsId, accountId, opts) {
      syncCalls.push({ workspaceId: wsId, accountId, opts });
      return {} as ConnectorRun;
    },
    async syncDueAccounts() {
      return 0;
    },
  };

  const app = fastify();
  await app.register(cookie, { secret: 'test-cookie-secret' });
  // Same HttpError -> { error: { code, message } } mapping as app.ts.
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
  app.addHook('onRequest', async (request) => {
    request.userId = auth.userId;
    request.workspaceId = auth.workspaceId;
    request.sessionId = 'ses_test';
  });
  registerSourceOauthRoutes(app, {
    db,
    config,
    audit: createAuditService({ db }),
    services: { ingestion, tokens: stubTokens },
  });
  await app.ready();
  openApps.push(app);
  return { app, db, auth, syncCalls };
}

afterEach(async () => {
  await Promise.all(openApps.map((app) => app.close()));
  openApps = [];
  vi.unstubAllGlobals();
  resetGoogleJwksCache();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Raw `name=value` pair of the signed state cookie from a start response. */
function stateCookieFrom(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie'];
  const list = (Array.isArray(header) ? header : [header]).filter(
    (c): c is string => typeof c === 'string',
  );
  const raw = list.find((c) => c.startsWith(`${SOURCE_STATE_COOKIE}=`));
  if (!raw) throw new Error('state cookie was not set');
  return raw.split(';')[0]!;
}

/** Run the start step and return what the callback needs. */
async function startFlow(
  app: FastifyInstance,
  sourceType = 'gmail',
  returnTo?: string,
): Promise<{ state: string; cookie: string; location: URL }> {
  const url =
    `/api/sources/oauth/google/${sourceType}/start` +
    (returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '');
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(302);
  const location = new URL(res.headers.location as string);
  return {
    state: location.searchParams.get('state') ?? '',
    cookie: stateCookieFrom(res),
    location,
  };
}

interface GoogleMocks {
  tokenResponse?: Record<string, unknown>;
  tokenStatus?: number;
  userinfo?: Record<string, unknown>;
  jwks?: Record<string, unknown>;
}

function mockGoogle(mocks: GoogleMocks = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return jsonResponse(
        mocks.tokenResponse ?? {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
          scope: `${GMAIL_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`,
        },
        mocks.tokenStatus ?? 200,
      );
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
      return jsonResponse(mocks.userinfo ?? { sub: 'g-sub-1', email: 'jane@gmail.com' });
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
      return jsonResponse(mocks.jwks ?? { keys: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('source oauth start', () => {
  it.each([
    ['gmail', GMAIL_SCOPE],
    ['google-drive', 'https://www.googleapis.com/auth/drive.metadata.readonly'],
    ['google-calendar', 'https://www.googleapis.com/auth/calendar.readonly'],
  ])('redirects %s to Google consent with least-privilege scopes + offline access', async (sourceType, scope) => {
    const { app } = await buildApp();
    const { location, state, cookie: stateCookie } = await startFlow(app, sourceType);

    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/sources/oauth/google/callback',
    );
    expect(location.searchParams.get('scope')).toBe(`${scope} openid email`);
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
    expect(location.searchParams.get('include_granted_scopes')).toBe('true');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(state.length).toBeGreaterThanOrEqual(16);
    expect(stateCookie).toContain(`${SOURCE_STATE_COOKIE}=`);
  });

  it('rejects unknown source types', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/sources/oauth/google/slack/start' });
    expect(res.statusCode).toBe(400);
  });

  it('returns not_configured without Google client credentials', async () => {
    const { app } = await buildApp(
      testConfig({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/sources/oauth/google/gmail/start' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_configured');
  });

  it('refuses with weak_token_key when prod indicators meet the dev-default key', async () => {
    // Secure cookies (HTTPS deployment) + no JARVIS_TOKEN_ENCRYPTION_KEY + the
    // dev-default JARVIS_SECRET: tokens would be encrypted with a public key.
    const { app } = await buildApp(testConfig({ JARVIS_COOKIE_SECURE: true }));
    const res = await app.inject({ method: 'GET', url: '/api/sources/oauth/google/gmail/start' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('weak_token_key');
  });

  it('starts normally in production once JARVIS_TOKEN_ENCRYPTION_KEY is set', async () => {
    const { app } = await buildApp(
      testConfig({ JARVIS_COOKIE_SECURE: true, JARVIS_TOKEN_ENCRYPTION_KEY: KEY }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/sources/oauth/google/gmail/start' });
    expect(res.statusCode).toBe(302);
  });

  it('starts normally in production with a strong (non-default) JARVIS_SECRET', async () => {
    const { app } = await buildApp({
      ...testConfig({ JARVIS_COOKIE_SECURE: true }),
      isProdSecret: true,
    });
    const res = await app.inject({ method: 'GET', url: '/api/sources/oauth/google/gmail/start' });
    expect(res.statusCode).toBe(302);
  });
});

describe('source oauth callback', () => {
  it('stores the encrypted grant, creates the source account, kicks a sync, and redirects', async () => {
    const { app, db, auth, syncCalls } = await buildApp();
    const { state, cookie: stateCookie } = await startFlow(app, 'gmail', '/settings');
    const { calls } = mockGoogle();

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=auth-code-1`,
      headers: { cookie: stateCookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/settings?connected=gmail');

    // The exchange carried the code + PKCE verifier; no token in any URL.
    const exchange = calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'));
    expect(String(exchange?.init?.body)).toContain('code=auth-code-1');
    expect(String(exchange?.init?.body)).toContain('grant_type=authorization_code');
    expect(String(exchange?.init?.body)).toContain('code_verifier=');

    const token = await db.selectFrom('oauthTokens').selectAll().executeTakeFirstOrThrow();
    expect(token).toMatchObject({
      provider: 'google',
      sourceType: 'gmail',
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      providerAccountId: 'g-sub-1',
      providerEmail: 'jane@gmail.com',
      status: 'active',
      lastError: null,
    });
    expect(decryptSecret(token.accessTokenEncrypted!, KEY)).toBe('at-1');
    expect(decryptSecret(token.refreshTokenEncrypted!, KEY)).toBe('rt-1');
    expect(JSON.parse(token.grantedScopes)).toContain(GMAIL_SCOPE);

    const account = await db.selectFrom('sourceAccounts').selectAll().executeTakeFirstOrThrow();
    expect(account).toMatchObject({
      provider: 'gmail',
      category: 'email',
      displayName: 'Gmail (jane@gmail.com)',
      status: 'connected',
      authRef: `oauth:${token.id}`,
      userId: auth.userId,
    });
    expect(JSON.parse(account.capabilities).length).toBeGreaterThan(0);
    expect(token.sourceAccountId).toBe(account.id);

    expect(syncCalls).toEqual([
      {
        workspaceId: auth.workspaceId,
        accountId: account.id,
        opts: { mode: 'full', triggeredBy: 'connect' },
      },
    ]);

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'source.oauth_connected')
      .execute();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('at-1');
    expect(JSON.stringify(audits)).not.toContain('rt-1');

    // The state cookie is single-use.
    const setCookies = res.headers['set-cookie'];
    const cleared = (Array.isArray(setCookies) ? setCookies : [setCookies]).find((c) =>
      String(c).startsWith(`${SOURCE_STATE_COOKIE}=`),
    );
    expect(String(cleared)).toContain('Expires=');
  });

  it('verifies an id_token via the Google JWKS instead of calling userinfo', async () => {
    const { app, db } = await buildApp();
    const { state, cookie: stateCookie } = await startFlow(app);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
    const idToken = await new SignJWT({ email: 'jane@gmail.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setSubject('g-sub-jwt')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const { calls } = mockGoogle({
      tokenResponse: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: `${GMAIL_SCOPE} openid`,
        id_token: idToken,
      },
      jwks: { keys: [jwk] },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`,
      headers: { cookie: stateCookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/settings?connected=gmail');

    const token = await db.selectFrom('oauthTokens').selectAll().executeTakeFirstOrThrow();
    expect(token.providerAccountId).toBe('g-sub-jwt');
    expect(calls.some((c) => c.url.startsWith('https://www.googleapis.com/oauth2/v3/certs'))).toBe(true);
    expect(calls.some((c) => c.url.includes('userinfo'))).toBe(false);
  });

  it('redirects with scope_denied when the required scope was not granted', async () => {
    const { app, db } = await buildApp();
    const { state, cookie: stateCookie } = await startFlow(app);
    mockGoogle({
      tokenResponse: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'openid email' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`,
      headers: { cookie: stateCookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/settings?sourceError=scope_denied');
    expect(await db.selectFrom('oauthTokens').selectAll().execute()).toHaveLength(0);
  });

  it('redirects with wrong_account when reauthorizing with a different Google account', async () => {
    const { app, db, auth } = await buildApp();
    const now = nowIso();
    await db
      .insertInto('oauthTokens')
      .values({
        id: newId('tok'),
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        provider: 'google',
        sourceType: 'gmail',
        sourceAccountId: null,
        providerAccountId: 'original-sub',
        providerEmail: 'original@gmail.com',
        grantedScopes: toJson([GMAIL_SCOPE]),
        accessTokenEncrypted: encryptSecret('original-at', KEY),
        refreshTokenEncrypted: encryptSecret('original-rt', KEY),
        accessTokenExpiresAt: now,
        status: 'needs_reauth',
        lastRefreshedAt: null,
        lastError: 'x',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const { state, cookie: stateCookie } = await startFlow(app);
    mockGoogle({ userinfo: { sub: 'a-different-sub', email: 'other@gmail.com' } });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`,
      headers: { cookie: stateCookie },
    });
    expect(res.headers.location).toBe('http://web.test/settings?sourceError=wrong_account');

    // The original grant is untouched.
    const token = await db.selectFrom('oauthTokens').selectAll().executeTakeFirstOrThrow();
    expect(token.providerAccountId).toBe('original-sub');
    expect(decryptSecret(token.accessTokenEncrypted!, KEY)).toBe('original-at');
    expect(token.status).toBe('needs_reauth');
  });

  it('keeps the previous refresh token when Google omits it on re-consent and reuses the account', async () => {
    const { app, db, auth } = await buildApp();
    const now = nowIso();
    const tokenRowId = newId('tok');
    const accountId = newId('acc');
    await db
      .insertInto('sourceAccounts')
      .values({
        id: accountId,
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        provider: 'gmail',
        category: 'email',
        displayName: 'Gmail (jane@gmail.com)',
        status: 'needs_auth',
        authRef: `oauth:${tokenRowId}`,
        scopes: toJson([GMAIL_SCOPE]),
        capabilities: toJson(['read']),
        settings: toJson({}),
        lastSyncAt: null,
        syncCursor: null,
        lastError: 'token refresh failed',
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    await db
      .insertInto('oauthTokens')
      .values({
        id: tokenRowId,
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        provider: 'google',
        sourceType: 'gmail',
        sourceAccountId: accountId,
        providerAccountId: 'g-sub-1',
        providerEmail: 'jane@gmail.com',
        grantedScopes: toJson([GMAIL_SCOPE]),
        accessTokenEncrypted: encryptSecret('old-at', KEY),
        refreshTokenEncrypted: encryptSecret('old-rt', KEY),
        accessTokenExpiresAt: now,
        status: 'needs_reauth',
        lastRefreshedAt: null,
        lastError: 'invalid_grant',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const { state, cookie: stateCookie } = await startFlow(app);
    mockGoogle({
      tokenResponse: { access_token: 'new-at', expires_in: 3600, scope: `${GMAIL_SCOPE} openid` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`,
      headers: { cookie: stateCookie },
    });
    expect(res.headers.location).toBe('http://web.test/settings?connected=gmail');

    const token = await db.selectFrom('oauthTokens').selectAll().executeTakeFirstOrThrow();
    expect(decryptSecret(token.accessTokenEncrypted!, KEY)).toBe('new-at');
    expect(decryptSecret(token.refreshTokenEncrypted!, KEY)).toBe('old-rt'); // preserved
    expect(token.status).toBe('active');
    expect(token.lastError).toBeNull();
    expect(token.sourceAccountId).toBe(accountId);

    // No duplicate account; the existing one is reconnected.
    const accounts = await db.selectFrom('sourceAccounts').selectAll().execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: accountId, status: 'connected', lastError: null });
  });

  it('rejects a state mismatch', async () => {
    const { app, db } = await buildApp();
    const { cookie: stateCookie } = await startFlow(app);
    mockGoogle();

    const res = await app.inject({
      method: 'GET',
      url: '/api/sources/oauth/google/callback?state=not-the-state&code=c1',
      headers: { cookie: stateCookie },
    });
    expect(res.headers.location).toBe('http://web.test/settings?sourceError=oauth_state_mismatch');
    expect(await db.selectFrom('oauthTokens').selectAll().execute()).toHaveLength(0);
  });

  it('rejects a callback without the state cookie', async () => {
    const { app } = await buildApp();
    mockGoogle();
    const res = await app.inject({
      method: 'GET',
      url: '/api/sources/oauth/google/callback?state=whatever&code=c1',
    });
    expect(res.headers.location).toBe('http://web.test/settings?sourceError=oauth_state_mismatch');
  });

  it('rejects a callback arriving on a different user session', async () => {
    const { app, db, auth } = await buildApp();
    const { state, cookie: stateCookie } = await startFlow(app);
    mockGoogle();

    // The state cookie was issued to the original user; switch sessions.
    const other = await seedWorkspace(db, { email: 'intruder@example.com' });
    auth.userId = other.userId;
    auth.workspaceId = other.workspaceId;

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`,
      headers: { cookie: stateCookie },
    });
    expect(res.headers.location).toBe('http://web.test/settings?sourceError=oauth_failed');
    expect(await db.selectFrom('oauthTokens').selectAll().execute()).toHaveLength(0);
  });

  it('maps a provider error to oauth_denied', async () => {
    const { app } = await buildApp();
    const { state, cookie: stateCookie } = await startFlow(app);
    mockGoogle();

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookie },
    });
    expect(res.headers.location).toBe('http://web.test/settings?sourceError=oauth_denied');
  });

  it('redirects with oauth_failed when the code exchange fails', async () => {
    const { app, db } = await buildApp();
    const { state, cookie: stateCookie } = await startFlow(app);
    mockGoogle({ tokenResponse: { error: 'invalid_grant' }, tokenStatus: 400 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=bad`,
      headers: { cookie: stateCookie },
    });
    expect(res.headers.location).toBe('http://web.test/settings?sourceError=oauth_failed');
    expect(await db.selectFrom('oauthTokens').selectAll().execute()).toHaveLength(0);
  });

  it('uses relative redirects when the web app is served from the same origin', async () => {
    const { app } = await buildApp(testConfig({ JARVIS_PUBLIC_DIR: '/srv/public' }));
    const { state, cookie: stateCookie } = await startFlow(app);
    mockGoogle();

    const res = await app.inject({
      method: 'GET',
      url: `/api/sources/oauth/google/callback?state=${encodeURIComponent(state)}&code=c1`,
      headers: { cookie: stateCookie },
    });
    expect(res.headers.location).toBe('/settings?connected=gmail');
  });
});
