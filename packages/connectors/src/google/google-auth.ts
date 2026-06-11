/**
 * Google OAuth helper: exchanges a long-lived refresh token for short-lived
 * access tokens and caches them in memory until shortly before expiry.
 *
 * Untested-against-live-API hook: request/response shapes follow the public
 * OAuth 2.0 docs (https://developers.google.com/identity/protocols/oauth2/web-server#offline)
 * but have not been exercised against Google's live endpoints.
 *
 * Credentials are resolved at call time via ctx.secrets (env-driven); secret
 * VALUES never appear in errors or logs — only env var NAMES.
 */
import type { ConnectorContext } from '../types.js';
import { httpErrorDetail } from '../util/parse.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
] as const;

export function missingGoogleEnv(ctx: ConnectorContext): string[] {
  return GOOGLE_REQUIRED_ENV.filter((name) => !ctx.secrets.get(name));
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/** Refresh-token -> access-token exchange with an in-memory expiry cache. */
export class GoogleAuth {
  private readonly cache = new Map<string, CachedToken>();

  /** Injectable clock (wall clock by default; adapters may read it for token expiry). */
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async getAccessToken(ctx: ConnectorContext): Promise<string> {
    // OAuth-connected accounts: the server-injected token source owns
    // storage, refresh, and reauth marking. The env-driven refresh-token
    // flow below stays as the backward-compatible path.
    if (ctx.oauth) return ctx.oauth.getAccessToken();

    const missing = missingGoogleEnv(ctx);
    if (missing.length > 0) {
      throw new Error(`not configured: missing env ${missing.join(', ')}`);
    }
    const clientId = ctx.secrets.get('GOOGLE_CLIENT_ID') ?? '';
    const clientSecret = ctx.secrets.get('GOOGLE_CLIENT_SECRET') ?? '';
    const refreshToken = ctx.secrets.get('GOOGLE_REFRESH_TOKEN') ?? '';

    const cacheKey = ctx.accountId;
    const cached = this.cache.get(cacheKey);
    // 30s safety margin so we never hand out a token about to expire.
    if (cached && cached.expiresAtMs - 30_000 > this.nowMs()) {
      return cached.accessToken;
    }

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${await httpErrorDetail(res)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Google token exchange returned no access_token');
    }
    this.cache.set(cacheKey, {
      accessToken: json.access_token,
      expiresAtMs: this.nowMs() + (json.expires_in ?? 3600) * 1000,
    });
    return json.access_token;
  }
}
