import { createHmac } from 'node:crypto';
import {
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../../config.js';
import { sha256Base64Url, type OauthStatePayload } from '../../lib/oauth.js';
import { createTestDb, seedWorkspace } from '../../test/helpers.js';
import {
  appSecretProof,
  buildStartRedirect,
  createLoginStatePayload,
  exchangeLoginCode,
  isLoginProvider,
  isProviderConfigured,
  loginRedirectUri,
  mintAppleClientSecret,
  parseAppleUserField,
  resolveOauthLogin,
  type OauthProfile,
} from './login-providers.js';

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
let appleServerKeys: KeyPair; // signs Apple id_tokens (Apple's side)
let appleClientKeys: KeyPair; // our ES256 key for minting client secrets
let applePrivateKeyPem: string;

beforeAll(async () => {
  googleKeys = await generateKeyPair('RS256', { extractable: true });
  appleServerKeys = await generateKeyPair('ES256', { extractable: true });
  appleClientKeys = await generateKeyPair('ES256', { extractable: true });
  applePrivateKeyPem = await exportPKCS8(appleClientKeys.privateKey);
  jwksStore.set('https://www.googleapis.com/oauth2/v3/certs', {
    keys: [{ ...(await exportJWK(googleKeys.publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' }],
  });
  jwksStore.set('https://appleid.apple.com/auth/keys', {
    keys: [{ ...(await exportJWK(appleServerKeys.publicKey)), kid: 'a1', alg: 'ES256', use: 'sig' }],
  });
});

function makeConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    DONNA_AUTH_MODE: 'password',
    DONNA_ALLOW_SIGNUP: 'true',
    DONNA_WEB_ORIGIN: 'http://web.test',
    DONNA_PUBLIC_URL: 'http://api.test',
    DONNA_PUBLIC_DIR: undefined,
    DONNA_COOKIE_SECURE: 'false',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    FACEBOOK_CLIENT_ID: 'fb-client-id',
    FACEBOOK_CLIENT_SECRET: 'fb-secret',
    APPLE_CLIENT_ID: 'com.donna.test',
    APPLE_TEAM_ID: 'TEAMID1234',
    APPLE_KEY_ID: 'KEYID12345',
    APPLE_PRIVATE_KEY: applePrivateKeyPem,
    ...overrides,
  });
}

// -- fetch mock --------------------------------------------------------------

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

afterEach(() => {
  vi.unstubAllGlobals();
});

function statePayload(overrides: Partial<OauthStatePayload> = {}): OauthStatePayload {
  return {
    state: 's'.repeat(32),
    intent: 'login',
    returnTo: '/',
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('provider registry', () => {
  it('recognizes exactly google/facebook/apple', () => {
    expect(isLoginProvider('google')).toBe(true);
    expect(isLoginProvider('facebook')).toBe(true);
    expect(isLoginProvider('apple')).toBe(true);
    expect(isLoginProvider('github')).toBe(false);
    expect(isLoginProvider(undefined)).toBe(false);
  });

  it('reports configured only when all creds are present', () => {
    const config = makeConfig();
    expect(isProviderConfigured('google', config)).toBe(true);
    expect(isProviderConfigured('apple', config)).toBe(true);
    expect(isProviderConfigured('google', makeConfig({ GOOGLE_CLIENT_SECRET: undefined }))).toBe(
      false,
    );
    expect(isProviderConfigured('apple', makeConfig({ APPLE_KEY_ID: undefined }))).toBe(false);
    expect(
      isProviderConfigured('facebook', makeConfig({ FACEBOOK_CLIENT_ID: undefined })),
    ).toBe(false);
  });
});

describe('createLoginStatePayload', () => {
  it('adds PKCE + nonce for google, nonce only for apple, neither for facebook', () => {
    const google = createLoginStatePayload('google', { intent: 'login' });
    expect(google.codeVerifier).toBeDefined();
    expect(google.nonce).toBeDefined();
    const apple = createLoginStatePayload('apple', { intent: 'login' });
    expect(apple.codeVerifier).toBeUndefined();
    expect(apple.nonce).toBeDefined();
    const facebook = createLoginStatePayload('facebook', { intent: 'login' });
    expect(facebook.codeVerifier).toBeUndefined();
    expect(facebook.nonce).toBeUndefined();
    expect(google.state).not.toBe(apple.state);
  });

  it('validates returnTo and defaults per intent', () => {
    expect(createLoginStatePayload('google', { intent: 'login' }).returnTo).toBe('/');
    expect(createLoginStatePayload('google', { intent: 'link' }).returnTo).toBe('/settings');
    expect(
      createLoginStatePayload('google', { intent: 'login', returnTo: '//evil' }).returnTo,
    ).toBe('/');
    expect(
      createLoginStatePayload('google', { intent: 'login', returnTo: '/inbox?tab=1' }).returnTo,
    ).toBe('/inbox?tab=1');
    expect(
      createLoginStatePayload('google', { intent: 'link', userId: 'usr_1' }).userId,
    ).toBe('usr_1');
  });
});

describe('buildStartRedirect', () => {
  it('google: OIDC + PKCE S256, login-only (no access_type)', () => {
    const config = makeConfig();
    const payload = createLoginStatePayload('google', { intent: 'login' });
    const url = new URL(buildStartRedirect('google', config, payload));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/auth/oauth/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe(payload.state);
    expect(url.searchParams.get('nonce')).toBe(payload.nonce ?? '');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      sha256Base64Url(payload.codeVerifier ?? ''),
    );
    expect(url.searchParams.has('access_type')).toBe(false);
  });

  it('facebook: state only, no PKCE/nonce', () => {
    const config = makeConfig();
    const payload = createLoginStatePayload('facebook', { intent: 'login' });
    const url = new URL(buildStartRedirect('facebook', config, payload));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v19.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('fb-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/auth/oauth/facebook/callback',
    );
    expect(url.searchParams.get('scope')).toBe('email,public_profile');
    expect(url.searchParams.get('state')).toBe(payload.state);
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('nonce')).toBe(false);
  });

  it('apple: form_post response mode with name+email scope and nonce', () => {
    const config = makeConfig();
    const payload = createLoginStatePayload('apple', { intent: 'login' });
    const url = new URL(buildStartRedirect('apple', config, payload));
    expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(url.searchParams.get('client_id')).toBe('com.donna.test');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/auth/oauth/apple/callback',
    );
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    expect(url.searchParams.get('scope')).toBe('name email');
    expect(url.searchParams.get('nonce')).toBe(payload.nonce ?? '');
    expect(url.searchParams.get('state')).toBe(payload.state);
  });

  it('builds redirect URIs from the public API URL', () => {
    const config = makeConfig({ DONNA_PUBLIC_URL: 'https://donna.example.com/' });
    expect(loginRedirectUri(config, 'apple')).toBe(
      'https://donna.example.com/api/auth/oauth/apple/callback',
    );
  });
});

describe('small helpers', () => {
  it('appSecretProof is HMAC-SHA256(access_token, app_secret) hex', () => {
    expect(appSecretProof('token-1', 'secret-1')).toBe(
      createHmac('sha256', 'secret-1').update('token-1').digest('hex'),
    );
  });

  it('parseAppleUserField extracts the full name from valid JSON only', () => {
    expect(
      parseAppleUserField(JSON.stringify({ name: { firstName: 'Tim', lastName: 'Apple' } })),
    ).toBe('Tim Apple');
    expect(parseAppleUserField(JSON.stringify({ name: { firstName: 'Tim' } }))).toBe('Tim');
    expect(parseAppleUserField(JSON.stringify({ name: {} }))).toBeNull();
    expect(parseAppleUserField('not-json')).toBeNull();
    expect(parseAppleUserField(undefined)).toBeNull();
  });

  it('mintAppleClientSecret produces a short-lived ES256 JWT with the right claims', async () => {
    const config = makeConfig();
    const secret = await mintAppleClientSecret(config);
    const header = decodeProtectedHeader(secret);
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEYID12345' });
    const { payload } = await jwtVerify(secret, appleClientKeys.publicKey, {
      issuer: 'TEAMID1234',
      audience: 'https://appleid.apple.com',
    });
    expect(payload.sub).toBe('com.donna.test');
    expect(payload.exp! - payload.iat!).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// Token exchange + profile normalization (mocked provider HTTP)
// ---------------------------------------------------------------------------

async function signGoogleIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
    .setIssuer('https://accounts.google.com')
    .setAudience('google-client-id')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(googleKeys.privateKey);
}

describe('exchangeLoginCode google', () => {
  it('exchanges the code with PKCE and returns the verified profile', async () => {
    const config = makeConfig();
    const state = statePayload({ nonce: 'nonce-123', codeVerifier: 'verifier-abc' });
    const idToken = await signGoogleIdToken({
      sub: 'google-sub-1',
      email: 'Ada@Example.com',
      email_verified: true,
      name: 'Ada Lovelace',
      picture: 'https://pic.example/ada.png',
      nonce: 'nonce-123',
    });
    fetchHandlers.push((url) =>
      url.startsWith('https://oauth2.googleapis.com/token')
        ? jsonResponse({ id_token: idToken, access_token: 'ya29.x', token_type: 'Bearer' })
        : null,
    );

    const profile = await exchangeLoginCode('google', config, 'auth-code-1', { state });
    expect(profile).toEqual({
      provider: 'google',
      providerAccountId: 'google-sub-1',
      email: 'ada@example.com',
      emailVerified: true,
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://pic.example/ada.png',
    });

    const tokenCall = fetchCalls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/'));
    expect(tokenCall?.init?.method).toBe('POST');
    const body = new URLSearchParams(String(tokenCall?.init?.body));
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toBe('verifier-abc');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe('http://api.test/api/auth/oauth/google/callback');
  });

  it('rejects id_tokens whose nonce does not match the state nonce', async () => {
    const config = makeConfig();
    const state = statePayload({ nonce: 'expected-nonce', codeVerifier: 'v' });
    const idToken = await signGoogleIdToken({ sub: 'g-sub', nonce: 'evil-replayed-nonce' });
    fetchHandlers.push((url) =>
      url.startsWith('https://oauth2.googleapis.com/token')
        ? jsonResponse({ id_token: idToken })
        : null,
    );
    await expect(exchangeLoginCode('google', config, 'code', { state })).rejects.toThrow(
      'nonce_mismatch',
    );
  });

  it('rejects id_tokens minted for a different audience', async () => {
    const config = makeConfig();
    const state = statePayload({ nonce: 'n1', codeVerifier: 'v' });
    const idToken = await new SignJWT({ sub: 'g-sub', nonce: 'n1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer('https://accounts.google.com')
      .setAudience('some-other-client')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(googleKeys.privateKey);
    fetchHandlers.push((url) =>
      url.startsWith('https://oauth2.googleapis.com/token')
        ? jsonResponse({ id_token: idToken })
        : null,
    );
    await expect(exchangeLoginCode('google', config, 'code', { state })).rejects.toThrow();
  });

  it('fails when the token endpoint errors (status only, no body leakage)', async () => {
    const config = makeConfig();
    fetchHandlers.push(() => jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(
      exchangeLoginCode('google', config, 'bad-code', { state: statePayload() }),
    ).rejects.toThrow('oauth_token_http_400');
  });
});

describe('exchangeLoginCode facebook', () => {
  it('fetches the profile with an appsecret_proof and normalizes it', async () => {
    const config = makeConfig();
    fetchHandlers.push((url) =>
      url.startsWith('https://graph.facebook.com/v19.0/oauth/access_token')
        ? jsonResponse({ access_token: 'fb-at-1', token_type: 'bearer' })
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

    const profile = await exchangeLoginCode('facebook', config, 'fb-code', {
      state: statePayload(),
    });
    expect(profile).toEqual({
      provider: 'facebook',
      providerAccountId: 'fb-123',
      email: 'grace@example.com',
      emailVerified: true,
      displayName: 'Grace Hopper',
      avatarUrl: 'https://pic.example/grace.png',
    });

    const tokenCall = fetchCalls.find((c) => c.url.includes('/oauth/access_token'));
    const tokenUrl = new URL(tokenCall?.url ?? '');
    expect(tokenUrl.searchParams.get('client_id')).toBe('fb-client-id');
    expect(tokenUrl.searchParams.get('client_secret')).toBe('fb-secret');
    expect(tokenUrl.searchParams.get('code')).toBe('fb-code');
    expect(tokenUrl.searchParams.get('redirect_uri')).toBe(
      'http://api.test/api/auth/oauth/facebook/callback',
    );

    const meCall = fetchCalls.find((c) => c.url.includes('/me'));
    const meUrl = new URL(meCall?.url ?? '');
    expect(meUrl.searchParams.get('fields')).toBe('id,name,email,picture.width(256)');
    expect(meUrl.searchParams.get('appsecret_proof')).toBe(appSecretProof('fb-at-1', 'fb-secret'));
  });

  it('treats a missing email as unverified/no email', async () => {
    const config = makeConfig();
    fetchHandlers.push((url) =>
      url.includes('/oauth/access_token') ? jsonResponse({ access_token: 'fb-at-2' }) : null,
    );
    fetchHandlers.push((url) =>
      url.includes('/me') ? jsonResponse({ id: 'fb-9', name: 'No Email' }) : null,
    );
    const profile = await exchangeLoginCode('facebook', config, 'c', { state: statePayload() });
    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
  });
});

describe('exchangeLoginCode apple', () => {
  it('verifies the id_token, coerces string email_verified and parses the user field', async () => {
    const config = makeConfig();
    const state = statePayload({ nonce: 'apple-nonce-1' });
    const idToken = await new SignJWT({
      email: 'Tim@Example.com',
      email_verified: 'true',
      nonce: 'apple-nonce-1',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'a1' })
      .setSubject('apple-sub-1')
      .setIssuer('https://appleid.apple.com')
      .setAudience('com.donna.test')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(appleServerKeys.privateKey);
    fetchHandlers.push((url) =>
      url.startsWith('https://appleid.apple.com/auth/token')
        ? jsonResponse({ id_token: idToken, access_token: 'apple-at' })
        : null,
    );

    const profile = await exchangeLoginCode('apple', config, 'apple-code', {
      state,
      userField: JSON.stringify({ name: { firstName: 'Tim', lastName: 'Apple' } }),
    });
    expect(profile).toEqual({
      provider: 'apple',
      providerAccountId: 'apple-sub-1',
      email: 'tim@example.com',
      emailVerified: true,
      displayName: 'Tim Apple',
      avatarUrl: null,
    });

    // The token call must carry a freshly minted ES256 client_secret JWT.
    const tokenCall = fetchCalls.find((c) => c.url.startsWith('https://appleid.apple.com/'));
    const body = new URLSearchParams(String(tokenCall?.init?.body));
    expect(body.get('client_id')).toBe('com.donna.test');
    expect(body.get('grant_type')).toBe('authorization_code');
    const clientSecret = body.get('client_secret') ?? '';
    expect(clientSecret.split('.')).toHaveLength(3);
    expect(decodeProtectedHeader(clientSecret)).toMatchObject({ alg: 'ES256', kid: 'KEYID12345' });
  });
});

// ---------------------------------------------------------------------------
// resolveOauthLogin
// ---------------------------------------------------------------------------

function profileOf(overrides: Partial<OauthProfile> = {}): OauthProfile {
  return {
    provider: 'google',
    providerAccountId: 'sub-1',
    email: 'ada@example.com',
    emailVerified: true,
    displayName: 'Ada Lovelace',
    avatarUrl: 'https://pic.example/ada.png',
    ...overrides,
  };
}

const loginCtx = { intent: 'login' as const, signupEnabled: true, authMode: 'password' as const };

describe('resolveOauthLogin (login intent)', () => {
  it('provisions a user + workspace + authAccount on first verified login', async () => {
    const db = await createTestDb();
    const outcome = await resolveOauthLogin(db, profileOf(), loginCtx);
    expect(outcome).toMatchObject({ status: 'ok', createdUser: true, linkedAccount: false });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.workspaceId).toBeTruthy();

    const user = await db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.email).toBe('ada@example.com');
    expect(user.name).toBe('Ada Lovelace');
    expect(user.emailVerified).toBe(1);
    expect(user.avatarUrl).toBe('https://pic.example/ada.png');
    expect(user.passwordHash).toBeNull();
    expect(user.lastLoginAt).toBeTruthy();

    const account = await db.selectFrom('authAccounts').selectAll().executeTakeFirstOrThrow();
    expect(account.userId).toBe(user.id);
    expect(account.provider).toBe('google');
    expect(account.providerAccountId).toBe('sub-1');
    expect(account.emailVerified).toBe(1);
    expect(account.lastLoginAt).toBeTruthy();
  });

  it('reuses the same user on subsequent logins', async () => {
    const db = await createTestDb();
    const first = await resolveOauthLogin(db, profileOf(), loginCtx);
    const second = await resolveOauthLogin(db, profileOf(), loginCtx);
    expect(second).toMatchObject({ status: 'ok', createdUser: false, linkedAccount: false });
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected ok');
    expect(second.user.id).toBe(first.user.id);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await db.selectFrom('authAccounts').select('id').execute()).toHaveLength(1);
  });

  it('does not erase the stored display name when the provider omits it later', async () => {
    const db = await createTestDb();
    await resolveOauthLogin(db, profileOf({ provider: 'apple', displayName: 'Tim Apple' }), loginCtx);
    await resolveOauthLogin(
      db,
      profileOf({ provider: 'apple', displayName: null, avatarUrl: null }),
      loginCtx,
    );
    const account = await db.selectFrom('authAccounts').selectAll().executeTakeFirstOrThrow();
    expect(account.displayName).toBe('Tim Apple');
  });

  it('links a verified email to the existing local user', async () => {
    const db = await createTestDb();
    const { userId } = await seedWorkspace(db, { email: 'ada@example.com' });
    const outcome = await resolveOauthLogin(db, profileOf(), loginCtx);
    expect(outcome).toMatchObject({ status: 'ok', createdUser: false, linkedAccount: true });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.user.id).toBe(userId);
    const account = await db.selectFrom('authAccounts').selectAll().executeTakeFirstOrThrow();
    expect(account.userId).toBe(userId);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  it('refuses to link an UNVERIFIED email to an existing user (no row is written)', async () => {
    const db = await createTestDb();
    await seedWorkspace(db, { email: 'ada@example.com' });
    const outcome = await resolveOauthLogin(db, profileOf({ emailVerified: false }), loginCtx);
    expect(outcome).toEqual({ status: 'error', code: 'email_unverified' });
    expect(await db.selectFrom('authAccounts').select('id').execute()).toHaveLength(0);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  it('provisions a new unverified user when no local account matches', async () => {
    const db = await createTestDb();
    const outcome = await resolveOauthLogin(db, profileOf({ emailVerified: false }), loginCtx);
    expect(outcome).toMatchObject({ status: 'ok', createdUser: true });
    const user = await db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.emailVerified).toBe(0);
  });

  it('errors with no_email when the provider returns no email', async () => {
    const db = await createTestDb();
    const outcome = await resolveOauthLogin(db, profileOf({ email: null }), loginCtx);
    expect(outcome).toEqual({ status: 'error', code: 'no_email' });
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(0);
  });

  it('refuses signup when registration is disabled (but local mode still allows)', async () => {
    const db = await createTestDb();
    const disabled = { ...loginCtx, signupEnabled: false };
    expect(await resolveOauthLogin(db, profileOf(), disabled)).toEqual({
      status: 'error',
      code: 'signup_disabled',
    });
    const local = { ...disabled, authMode: 'local' as const };
    expect(await resolveOauthLogin(db, profileOf(), local)).toMatchObject({
      status: 'ok',
      createdUser: true,
    });
  });
});

describe('resolveOauthLogin (link intent)', () => {
  it('attaches the identity to the session user', async () => {
    const db = await createTestDb();
    const { userId } = await seedWorkspace(db);
    const outcome = await resolveOauthLogin(db, profileOf(), {
      ...loginCtx,
      intent: 'link',
      userId,
    });
    expect(outcome).toMatchObject({ status: 'ok', linkedAccount: true, workspaceId: null });
    const account = await db.selectFrom('authAccounts').selectAll().executeTakeFirstOrThrow();
    expect(account.userId).toBe(userId);
  });

  it('rejects identities already linked to a different user', async () => {
    const db = await createTestDb();
    await resolveOauthLogin(db, profileOf(), loginCtx); // owns sub-1 now
    const { userId: otherUser } = await seedWorkspace(db, { email: 'other@example.com' });
    const outcome = await resolveOauthLogin(db, profileOf(), {
      ...loginCtx,
      intent: 'link',
      userId: otherUser,
    });
    expect(outcome).toEqual({ status: 'error', code: 'already_linked' });
    expect(await db.selectFrom('authAccounts').select('id').execute()).toHaveLength(1);
  });

  it('re-linking your own identity just refreshes the profile fields', async () => {
    const db = await createTestDb();
    const { userId } = await seedWorkspace(db);
    await resolveOauthLogin(db, profileOf(), { ...loginCtx, intent: 'link', userId });
    const outcome = await resolveOauthLogin(
      db,
      profileOf({ avatarUrl: 'https://pic.example/new.png' }),
      { ...loginCtx, intent: 'link', userId },
    );
    expect(outcome).toMatchObject({ status: 'ok', linkedAccount: false });
    const accounts = await db.selectFrom('authAccounts').selectAll().execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.avatarUrl).toBe('https://pic.example/new.png');
  });

  it('fails closed when the link user is missing', async () => {
    const db = await createTestDb();
    const outcome = await resolveOauthLogin(db, profileOf(), {
      ...loginCtx,
      intent: 'link',
      userId: 'usr_gone',
    });
    expect(outcome).toEqual({ status: 'error', code: 'oauth_failed' });
  });
});
