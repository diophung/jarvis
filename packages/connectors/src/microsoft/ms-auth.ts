/**
 * Microsoft identity platform OAuth helper: exchanges a refresh token for
 * access tokens against the v2.0 token endpoint and caches them in memory.
 *
 * Untested-against-live-API hook: request/response shapes follow the public
 * docs (https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token)
 * but have not been exercised against a live tenant.
 *
 * Secret VALUES never appear in errors or logs — only env var NAMES.
 */
import type { ConnectorContext } from '../types.js';
import { httpErrorDetail } from '../util/parse.js';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

export const MS_REQUIRED_ENV = [
  'MS_CLIENT_ID',
  'MS_CLIENT_SECRET',
  'MS_TENANT_ID',
  'MS_REFRESH_TOKEN',
] as const;

export function missingMsEnv(ctx: ConnectorContext): string[] {
  return MS_REQUIRED_ENV.filter((name) => !ctx.secrets.get(name));
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/** Refresh-token -> access-token exchange with an in-memory expiry cache. */
export class MicrosoftAuth {
  private readonly cache = new Map<string, CachedToken>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async getAccessToken(ctx: ConnectorContext): Promise<string> {
    const missing = missingMsEnv(ctx);
    if (missing.length > 0) {
      throw new Error(`not configured: missing env ${missing.join(', ')}`);
    }
    const clientId = ctx.secrets.get('MS_CLIENT_ID') ?? '';
    const clientSecret = ctx.secrets.get('MS_CLIENT_SECRET') ?? '';
    const tenantId = ctx.secrets.get('MS_TENANT_ID') ?? '';
    const refreshToken = ctx.secrets.get('MS_REFRESH_TOKEN') ?? '';

    const cacheKey = ctx.accountId;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs - 30_000 > this.nowMs()) {
      return cached.accessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/.default offline_access',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Microsoft token exchange failed: ${await httpErrorDetail(res)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Microsoft token exchange returned no access_token');
    }
    this.cache.set(cacheKey, {
      accessToken: json.access_token,
      expiresAtMs: this.nowMs() + (json.expires_in ?? 3600) * 1000,
    });
    return json.access_token;
  }
}
