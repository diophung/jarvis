import { newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createTokensService, GOOGLE_REVOKE_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from './tokens.js';

const KEY = 'test-token-key';

function testConfig(): AppConfig {
  return {
    env: {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
    } as AppConfig['env'],
    isProdSecret: false,
    uploadsDir: '/tmp/donna-test-uploads',
    sqlitePath: ':memory:',
    publicUrl: 'http://api.test',
    tokenEncryptionKey: KEY,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Seeded {
  db: Db;
  userId: string;
  workspaceId: string;
  accountId: string;
  tokenRowId: string;
  service: ReturnType<typeof createTokensService>;
}

async function seed(opts: {
  accessToken?: string | null;
  refreshToken?: string | null;
  /** Milliseconds from now; negative = expired. */
  expiresInMs?: number | null;
  sourceType?: string;
}): Promise<Seeded> {
  const db = await createTestDb();
  const { userId, workspaceId } = await seedWorkspace(db);
  const now = nowIso();
  const accountId = newId('acc');
  const tokenRowId = newId('tok');

  await db
    .insertInto('sourceAccounts')
    .values({
      id: accountId,
      workspaceId,
      userId,
      provider: opts.sourceType ?? 'gmail',
      category: 'email',
      displayName: 'Gmail (jane@gmail.com)',
      status: 'connected',
      authRef: `oauth:${tokenRowId}`,
      scopes: toJson(['https://www.googleapis.com/auth/gmail.readonly']),
      capabilities: toJson(['read', 'list']),
      settings: toJson({}),
      lastSyncAt: null,
      syncCursor: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  await db
    .insertInto('oauthTokens')
    .values({
      id: tokenRowId,
      workspaceId,
      userId,
      provider: 'google',
      sourceType: opts.sourceType ?? 'gmail',
      sourceAccountId: accountId,
      providerAccountId: 'g-sub-1',
      providerEmail: 'jane@gmail.com',
      grantedScopes: toJson(['https://www.googleapis.com/auth/gmail.readonly']),
      accessTokenEncrypted:
        opts.accessToken == null ? null : encryptSecret(opts.accessToken, KEY),
      refreshTokenEncrypted:
        opts.refreshToken == null ? null : encryptSecret(opts.refreshToken, KEY),
      accessTokenExpiresAt:
        opts.expiresInMs == null ? null : new Date(Date.now() + opts.expiresInMs).toISOString(),
      status: 'active',
      lastRefreshedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  const service = createTokensService({
    db,
    config: testConfig(),
    audit: createAuditService({ db }),
  });
  return { db, userId, workspaceId, accountId, tokenRowId, service };
}

async function tokenRow(db: Db, id: string) {
  return db.selectFrom('oauthTokens').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tokens service — access tokens', () => {
  it('returns the stored (encrypted-at-rest) access token without any fetch while fresh', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { db, userId, tokenRowId, service } = await seed({
      accessToken: 'cached-access-token',
      refreshToken: 'refresh-plain',
      expiresInMs: 3600_000,
    });

    await expect(service.getGoogleAccessTokenForUser(userId, 'gmail')).resolves.toBe(
      'cached-access-token',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Roundtrip sanity: what is stored is ciphertext, not the raw token.
    const row = await tokenRow(db, tokenRowId);
    expect(row.accessTokenEncrypted).not.toContain('cached-access-token');
    expect(decryptSecret(row.accessTokenEncrypted!, KEY)).toBe('cached-access-token');
  });

  it('refreshes an expired token, stores it encrypted, and clears the error state', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(GOOGLE_TOKEN_ENDPOINT);
      const body = String(init?.body);
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=refresh-plain');
      expect(body).toContain('client_id=test-client-id');
      return jsonResponse({ access_token: 'new-access-token', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { db, userId, tokenRowId, service } = await seed({
      accessToken: 'stale-access-token',
      refreshToken: 'refresh-plain',
      expiresInMs: -1000,
    });

    await expect(service.getGoogleAccessTokenForUser(userId, 'gmail')).resolves.toBe(
      'new-access-token',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const row = await tokenRow(db, tokenRowId);
    expect(decryptSecret(row.accessTokenEncrypted!, KEY)).toBe('new-access-token');
    expect(decryptSecret(row.refreshTokenEncrypted!, KEY)).toBe('refresh-plain');
    expect(row.status).toBe('active');
    expect(row.lastRefreshedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(Date.parse(row.accessTokenExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it('single-flights concurrent refreshes: two callers, one token exchange', async () => {
    let resolveExchange!: (value: Response) => void;
    const exchange = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    const fetchMock = vi.fn(() => exchange);
    vi.stubGlobal('fetch', fetchMock);
    const { userId, accountId, service } = await seed({
      accessToken: 'stale',
      refreshToken: 'refresh-plain',
      expiresInMs: -1000,
    });

    const p1 = service.getGoogleAccessTokenForUser(userId, 'gmail');
    const p2 = service.tokenSourceFor(accountId).getAccessToken();
    // Let both callers reach the refresh before the exchange resolves.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveExchange(jsonResponse({ access_token: 'shared-token', expires_in: 3600 }));
    await expect(Promise.all([p1, p2])).resolves.toEqual(['shared-token', 'shared-token']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshGoogleTokenIfNeeded is a no-op while fresh and refreshes when stale', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'fresh', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);

    const fresh = await seed({ accessToken: 'ok', refreshToken: 'r', expiresInMs: 3600_000 });
    await fresh.service.refreshGoogleTokenIfNeeded(fresh.userId, 'gmail');
    expect(fetchMock).not.toHaveBeenCalled();

    const stale = await seed({ accessToken: 'old', refreshToken: 'r', expiresInMs: -1 });
    await stale.service.refreshGoogleTokenIfNeeded(stale.userId, 'gmail');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = await tokenRow(stale.db, stale.tokenRowId);
    expect(decryptSecret(row.accessTokenEncrypted!, KEY)).toBe('fresh');
  });
});

describe('tokens service — invalid_grant', () => {
  it('marks the grant and account as needing reauth, audits, and throws (no token material)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const { db, userId, accountId, tokenRowId, service } = await seed({
      accessToken: 'stale',
      refreshToken: 'refresh-plain',
      expiresInMs: -1000,
    });

    await expect(service.getGoogleAccessTokenForUser(userId, 'gmail')).rejects.toThrow(
      'reauthorization required for gmail',
    );

    const row = await tokenRow(db, tokenRowId);
    expect(row.status).toBe('needs_reauth');
    expect(row.lastError).toContain('invalid_grant');

    const account = await db
      .selectFrom('sourceAccounts')
      .selectAll()
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(account.status).toBe('needs_auth');
    expect(account.lastError).not.toBeNull();

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'source.token_refresh_failed')
      .execute();
    expect(audits).toHaveLength(1);
    // No token material anywhere in the audit trail or account error.
    const trail = JSON.stringify(audits) + JSON.stringify(row.lastError) + JSON.stringify(account);
    expect(trail).not.toContain('refresh-plain');
    expect(trail).not.toContain('stale');
  });
});

describe('tokens service — disconnect', () => {
  it('revokes at Google, wipes the stored tokens, marks revoked, and audits', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, accountId, tokenRowId, service } = await seed({
      accessToken: 'access-plain',
      refreshToken: 'refresh-plain',
      expiresInMs: 3600_000,
    });

    await service.disconnectSource(accountId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(GOOGLE_REVOKE_ENDPOINT);
    expect(String(init.body)).toBe('token=refresh-plain');

    const row = await tokenRow(db, tokenRowId);
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.refreshTokenEncrypted).toBeNull();
    expect(row.accessTokenExpiresAt).toBeNull();
    expect(row.status).toBe('revoked');

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'source.oauth_disconnected')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(accountId);
    expect(JSON.stringify(audits)).not.toContain('refresh-plain');
  });

  it('still wipes the tokens when the revocation call fails (best effort)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { db, accountId, tokenRowId, service } = await seed({
      accessToken: 'access-plain',
      refreshToken: 'refresh-plain',
      expiresInMs: 3600_000,
    });

    await service.disconnectSource(accountId);
    const row = await tokenRow(db, tokenRowId);
    expect(row.refreshTokenEncrypted).toBeNull();
    expect(row.status).toBe('revoked');
  });

  it('is a no-op for accounts without a grant', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { service } = await seed({ accessToken: 'a', refreshToken: 'r', expiresInMs: 1000 });
    await service.disconnectSource('acc_does_not_exist');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tokens service — isOauthAccount', () => {
  it('detects oauth authRefs only', async () => {
    const { service } = await seed({ accessToken: 'a', refreshToken: 'r', expiresInMs: 1000 });
    expect(service.isOauthAccount('oauth:tok_123')).toBe(true);
    expect(service.isOauthAccount('GOOGLE_CLIENT_ID')).toBe(false);
    expect(service.isOauthAccount(null)).toBe(false);
  });
});
