/**
 * TokensService: per-source Google OAuth grants — encrypted token storage,
 * access-token refresh (single-flight per grant), and revocation.
 *
 * Raw tokens only ever leave this module as the return value handed to the
 * connector layer; they are NEVER logged, audited, or embedded in error
 * messages. Storage uses AES-256-GCM via lib/crypto with
 * config.tokenEncryptionKey.
 */
import { nowIso } from '@jarvis/core';
import type { Db, OauthTokensTable } from '@jarvis/db';
import type { AppConfig } from '../config.js';
import type { AuditService, TokensService } from '../context.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** Refresh slightly before expiry so a handed-out token never dies mid-call. */
const EXPIRY_MARGIN_MS = 60_000;

export function createTokensService(deps: {
  db: Db;
  config: AppConfig;
  audit: AuditService;
}): TokensService {
  const { db, config, audit } = deps;

  /** rowId -> in-flight refresh, so concurrent syncs share one exchange. */
  const inflight = new Map<string, Promise<string>>();

  const encrypt = (plaintext: string): string =>
    encryptSecret(plaintext, config.tokenEncryptionKey);
  const decrypt = (encrypted: string | null): string | null =>
    encrypted === null ? null : decryptSecret(encrypted, config.tokenEncryptionKey);

  async function rowFor(userId: string, sourceType: string): Promise<OauthTokensTable | undefined> {
    return db
      .selectFrom('oauthTokens')
      .selectAll()
      .where('userId', '=', userId)
      .where('provider', '=', 'google')
      .where('sourceType', '=', sourceType)
      .executeTakeFirst();
  }

  async function rowByAccount(sourceAccountId: string): Promise<OauthTokensTable | undefined> {
    return db
      .selectFrom('oauthTokens')
      .selectAll()
      .where('sourceAccountId', '=', sourceAccountId)
      .executeTakeFirst();
  }

  function hasFreshAccessToken(row: OauthTokensTable): boolean {
    return (
      row.accessTokenEncrypted !== null &&
      row.accessTokenExpiresAt !== null &&
      Date.parse(row.accessTokenExpiresAt) - EXPIRY_MARGIN_MS > Date.now()
    );
  }

  /**
   * Mark the grant (and its linked source account) as needing user
   * reauthorization. `detail` must never contain token material.
   */
  async function markNeedsReauth(row: OauthTokensTable, detail: string): Promise<void> {
    const now = nowIso();
    await db
      .updateTable('oauthTokens')
      .set({ status: 'needs_reauth', lastError: detail, updatedAt: now })
      .where('id', '=', row.id)
      .execute();
    if (row.sourceAccountId) {
      await db
        .updateTable('sourceAccounts')
        .set({
          status: 'needs_auth',
          lastError: `Google authorization expired — reconnect ${row.sourceType}`,
          updatedAt: now,
        })
        .where('id', '=', row.sourceAccountId)
        .execute();
    }
    await audit.log({
      workspaceId: row.workspaceId,
      userId: row.userId,
      eventType: 'source.token_refresh_failed',
      actor: 'system',
      targetType: 'oauth_token',
      targetId: row.id,
      summary: `Google token refresh failed for ${row.sourceType} — reauthorization required`,
      metadata: { sourceType: row.sourceType, detail },
    });
  }

  async function doRefresh(row: OauthTokensTable): Promise<string> {
    const clientId = config.env.GOOGLE_CLIENT_ID;
    const clientSecret = config.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
    }
    const refreshToken = decrypt(row.refreshTokenEncrypted);
    if (!refreshToken) {
      await markNeedsReauth(row, 'no usable refresh token on record');
      throw new Error(`reauthorization required for ${row.sourceType}`);
    }

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
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
      // Only the OAuth error CODE is recorded — never tokens or raw bodies.
      let errorCode = `http_${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (typeof body.error === 'string') errorCode = body.error;
      } catch {
        // non-JSON error body; keep the status code
      }
      if (errorCode === 'invalid_grant' || res.status === 400 || res.status === 401) {
        await markNeedsReauth(row, `Google rejected the stored grant (${errorCode})`);
        throw new Error(`reauthorization required for ${row.sourceType}`);
      }
      throw new Error(`Google token refresh failed (${errorCode})`);
    }

    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!json.access_token) {
      throw new Error('Google token refresh returned no access token');
    }
    const now = nowIso();
    await db
      .updateTable('oauthTokens')
      .set({
        accessTokenEncrypted: encrypt(json.access_token),
        accessTokenExpiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
        // Google may rotate the refresh token; keep the old one otherwise.
        ...(json.refresh_token ? { refreshTokenEncrypted: encrypt(json.refresh_token) } : {}),
        status: 'active',
        lastRefreshedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where('id', '=', row.id)
      .execute();
    return json.access_token;
  }

  /** Single-flight wrapper: concurrent callers share one refresh per grant. */
  function refreshRow(row: OauthTokensTable): Promise<string> {
    const existing = inflight.get(row.id);
    if (existing) return existing;
    const promise = doRefresh(row).finally(() => inflight.delete(row.id));
    inflight.set(row.id, promise);
    return promise;
  }

  async function accessTokenForRow(row: OauthTokensTable): Promise<string> {
    if (hasFreshAccessToken(row)) {
      const token = decrypt(row.accessTokenEncrypted);
      // Undecryptable (e.g. key rotated without re-encrypting) falls through
      // to a refresh, which re-encrypts under the current key.
      if (token !== null) return token;
    }
    return refreshRow(row);
  }

  return {
    async getGoogleAccessTokenForUser(userId, sourceType) {
      const row = await rowFor(userId, sourceType);
      if (!row) throw new Error(`no Google authorization on record for ${sourceType}`);
      return accessTokenForRow(row);
    },

    async refreshGoogleTokenIfNeeded(userId, sourceType) {
      const row = await rowFor(userId, sourceType);
      if (!row || hasFreshAccessToken(row)) return;
      await refreshRow(row);
    },

    tokenSourceFor(sourceAccountId) {
      return {
        getAccessToken: async () => {
          const row = await rowByAccount(sourceAccountId);
          if (!row) throw new Error('no OAuth grant linked to this source account');
          return accessTokenForRow(row);
        },
      };
    },

    isOauthAccount(authRef) {
      return authRef !== null && authRef.startsWith('oauth:');
    },

    async disconnectSource(sourceAccountId) {
      const row = await rowByAccount(sourceAccountId);
      if (!row) return;

      // Best-effort revocation at Google; local cleanup happens regardless.
      const revocable = decrypt(row.refreshTokenEncrypted) ?? decrypt(row.accessTokenEncrypted);
      if (revocable) {
        try {
          await fetch(GOOGLE_REVOKE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: revocable }).toString(),
          });
        } catch {
          // Revocation is best effort; never block disconnect on it.
        }
      }

      const now = nowIso();
      await db
        .updateTable('oauthTokens')
        .set({
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          accessTokenExpiresAt: null,
          status: 'revoked',
          lastError: null,
          updatedAt: now,
        })
        .where('id', '=', row.id)
        .execute();

      await audit.log({
        workspaceId: row.workspaceId,
        userId: row.userId,
        eventType: 'source.oauth_disconnected',
        actor: 'user',
        targetType: 'source_account',
        targetId: sourceAccountId,
        summary: `Disconnected Google ${row.sourceType} OAuth grant`,
        metadata: { sourceType: row.sourceType },
      });
    },
  };
}
