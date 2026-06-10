import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuth, GOOGLE_TOKEN_URL } from './google-auth.js';
import { makeCtx } from '../test-helpers.js';

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'env-refresh-token',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleAuth getAccessToken', () => {
  it('prefers the server-injected ctx.oauth token source over env credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const oauthSource = { getAccessToken: vi.fn(async () => 'oauth-access-token') };

    const auth = new GoogleAuth();
    // ctx.oauth present AND env creds present: oauth must win.
    const ctx = makeCtx({ secretValues: GOOGLE_ENV, oauth: oauthSource });

    await expect(auth.getAccessToken(ctx)).resolves.toBe('oauth-access-token');
    expect(oauthSource.getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('works via ctx.oauth with no env credentials at all', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const auth = new GoogleAuth();
    const ctx = makeCtx({ oauth: { getAccessToken: async () => 'oauth-only-token' } });

    await expect(auth.getAccessToken(ctx)).resolves.toBe('oauth-only-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the env refresh-token flow when ctx.oauth is absent (backward compat)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(GOOGLE_TOKEN_URL);
      const body = String(init?.body);
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=env-refresh-token');
      return jsonResponse({ access_token: 'env-access-token', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const auth = new GoogleAuth();
    const ctx = makeCtx({ secretValues: GOOGLE_ENV });

    await expect(auth.getAccessToken(ctx)).resolves.toBe('env-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still reports missing env vars when neither ctx.oauth nor env creds exist', async () => {
    const auth = new GoogleAuth();
    await expect(auth.getAccessToken(makeCtx())).rejects.toThrow(
      'not configured: missing env GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN',
    );
  });
});
