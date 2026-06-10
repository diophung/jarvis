import { createHash } from 'node:crypto';
import cookie from '@fastify/cookie';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkcePair,
  randomToken,
  readStateCookie,
  setStateCookie,
  sha256Base64Url,
  statesMatch,
  validateReturnTo,
  type OauthStatePayload,
  type StateCookieOptions,
} from './oauth.js';

describe('validateReturnTo', () => {
  it('keeps safe in-app paths (with query strings)', () => {
    expect(validateReturnTo('/')).toBe('/');
    expect(validateReturnTo('/settings')).toBe('/settings');
    expect(validateReturnTo('/ok?q=1')).toBe('/ok?q=1');
    expect(validateReturnTo('/a/b/c?x=1&y=2#frag')).toBe('/a/b/c?x=1&y=2#frag');
  });

  it("rejects protocol-relative '//' URLs", () => {
    expect(validateReturnTo('//evil')).toBe('/');
    expect(validateReturnTo('//evil.example/path')).toBe('/');
  });

  it('rejects absolute URLs and embedded schemes', () => {
    expect(validateReturnTo('https://x')).toBe('/');
    expect(validateReturnTo('http://evil.example')).toBe('/');
    expect(validateReturnTo('/redirect?to=https://evil.example')).toBe('/');
    expect(validateReturnTo('javascript:alert(1)')).toBe('/');
  });

  it('rejects backslashes and control characters', () => {
    expect(validateReturnTo('/a\\b')).toBe('/');
    expect(validateReturnTo('\\/evil.example')).toBe('/');
    expect(validateReturnTo('/a\rb')).toBe('/');
    expect(validateReturnTo('/a\nb')).toBe('/');
  });

  it('rejects non-strings, empties, relative paths and oversized input', () => {
    expect(validateReturnTo(undefined)).toBe('/');
    expect(validateReturnTo(null)).toBe('/');
    expect(validateReturnTo(42)).toBe('/');
    expect(validateReturnTo('')).toBe('/');
    expect(validateReturnTo('relative/path')).toBe('/');
    expect(validateReturnTo(`/${'a'.repeat(600)}`)).toBe('/');
  });
});

describe('PKCE', () => {
  it('creates an S256 challenge that matches the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
    expect(challenge).toBe(sha256Base64Url(verifier));
  });

  it('uses a base64url verifier within the RFC 7636 length bounds', () => {
    const { verifier } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('generates unique pairs', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('randomToken / sha256Base64Url', () => {
  it('produces unique base64url tokens of the requested size', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(43); // 32 bytes base64url, no padding
    expect(randomToken()).not.toBe(token);
    expect(randomToken(16).length).toBeLessThan(token.length);
  });

  it('hashes to base64url sha256', () => {
    expect(sha256Base64Url('test')).toBe(
      createHash('sha256').update('test').digest('base64url'),
    );
  });
});

describe('statesMatch', () => {
  it('matches only equal non-empty strings', () => {
    expect(statesMatch('abc-state', 'abc-state')).toBe(true);
    expect(statesMatch('abc-state', 'abd-state')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
    expect(statesMatch(undefined, 'abc')).toBe(false);
    expect(statesMatch('abc', undefined)).toBe(false);
    expect(statesMatch(123 as unknown, '123')).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('appends and encodes query params on the base URL', () => {
    const url = buildAuthorizeUrl('https://provider.example/auth', {
      client_id: 'abc',
      scope: 'openid email profile',
      redirect_uri: 'http://localhost:3001/api/cb',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://provider.example/auth');
    expect(parsed.searchParams.get('client_id')).toBe('abc');
    expect(parsed.searchParams.get('scope')).toBe('openid email profile');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:3001/api/cb');
  });
});

// ---------------------------------------------------------------------------
// State cookie roundtrip
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'donna_oauth_login';

interface CookieApp {
  app: FastifyInstance;
  setCookie(payload: OauthStatePayload, opts?: StateCookieOptions): Promise<string>;
  readCookie(cookieValue: string | undefined): Promise<OauthStatePayload | null>;
}

let openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.map((app) => app.close()));
  openApps = [];
});

async function buildCookieApp(): Promise<CookieApp> {
  const app = fastify();
  await app.register(cookie, { secret: 'test-secret' });
  let toSet: { payload: OauthStatePayload; opts: StateCookieOptions } | null = null;
  let lastRead: OauthStatePayload | null = null;
  app.get('/set', async (_request, reply) => {
    if (!toSet) throw new Error('nothing to set');
    setStateCookie(reply, COOKIE_NAME, toSet.payload, toSet.opts);
    return { ok: true };
  });
  app.get('/read', async (request) => {
    lastRead = readStateCookie(request, COOKIE_NAME);
    return { found: lastRead !== null };
  });
  await app.ready();
  openApps.push(app);
  return {
    app,
    async setCookie(payload, opts = { sameSite: 'lax', secure: false }) {
      toSet = { payload, opts };
      const res = await app.inject({ method: 'GET', url: '/set' });
      expect(res.statusCode).toBe(200);
      const set = res.cookies.find((c) => c.name === COOKIE_NAME);
      expect(set).toBeDefined();
      return set!.value;
    },
    async readCookie(cookieValue) {
      lastRead = null;
      const res = await app.inject({
        method: 'GET',
        url: '/read',
        cookies: cookieValue === undefined ? {} : { [COOKIE_NAME]: cookieValue },
      });
      expect(res.statusCode).toBe(200);
      return lastRead;
    },
  };
}

function makePayload(overrides: Partial<OauthStatePayload> = {}): OauthStatePayload {
  return {
    state: randomToken(32),
    intent: 'login',
    returnTo: '/after',
    nonce: randomToken(16),
    codeVerifier: randomToken(48),
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('state cookie', () => {
  it('roundtrips the full payload through the signed cookie', async () => {
    const harness = await buildCookieApp();
    const payload = makePayload({ intent: 'link', userId: 'usr_1' });
    const value = await harness.setCookie(payload);
    expect(await harness.readCookie(value)).toEqual(payload);
  });

  it('sets a short-lived, httpOnly, signed cookie scoped to /api', async () => {
    const harness = await buildCookieApp();
    await harness.setCookie(makePayload());
    const res = await harness.app.inject({ method: 'GET', url: '/set' });
    const header = String(res.headers['set-cookie']);
    expect(header).toContain('Max-Age=600');
    expect(header).toContain('Path=/api');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
  });

  it('forces Secure when SameSite=None (apple form_post)', async () => {
    const harness = await buildCookieApp();
    await harness.setCookie(makePayload(), { sameSite: 'none', secure: false });
    const res = await harness.app.inject({ method: 'GET', url: '/set' });
    const header = String(res.headers['set-cookie']);
    expect(header).toContain('SameSite=None');
    expect(header).toContain('Secure');
  });

  it('rejects expired payloads (issuedAt older than 10 minutes)', async () => {
    const harness = await buildCookieApp();
    const stale = makePayload({ issuedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
    const value = await harness.setCookie(stale);
    expect(await harness.readCookie(value)).toBeNull();
  });

  it('rejects payloads issued in the future or with garbage issuedAt', async () => {
    const harness = await buildCookieApp();
    const future = makePayload({ issuedAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await harness.readCookie(await harness.setCookie(future))).toBeNull();
    const garbage = makePayload({ issuedAt: 'not-a-date' });
    expect(await harness.readCookie(await harness.setCookie(garbage))).toBeNull();
  });

  it('rejects tampered cookie values (signature no longer matches)', async () => {
    const harness = await buildCookieApp();
    const payload = makePayload();
    const value = await harness.setCookie(payload);
    expect(value).toContain('login'); // intent is part of the JSON payload
    const tampered = value.replace('login', 'link!');
    expect(await harness.readCookie(tampered)).toBeNull();
  });

  it('rejects unsigned/garbage cookies and missing cookies', async () => {
    const harness = await buildCookieApp();
    expect(await harness.readCookie(undefined)).toBeNull();
    expect(await harness.readCookie('not-a-signed-cookie')).toBeNull();
    expect(await harness.readCookie(JSON.stringify(makePayload()))).toBeNull();
  });

  it('rejects payloads whose state is too short', async () => {
    const harness = await buildCookieApp();
    const weak = makePayload({ state: 'short' });
    const value = await harness.setCookie(weak);
    expect(await harness.readCookie(value)).toBeNull();
  });
});
