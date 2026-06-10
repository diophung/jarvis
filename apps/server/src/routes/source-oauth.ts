/**
 * Google data-source authorization routes (docs/api-contract.md "Google
 * source authorization"). Browser-navigation flow, distinct from OAuth LOGIN:
 * an already-authenticated user grants Donna least-privilege, read-only
 * access to one Google source (gmail / google-drive / google-calendar).
 *
 * Security invariants:
 *  - the signed state cookie binds the flow to the session user; a callback
 *    arriving on a different session is rejected
 *  - PKCE (S256) on top of the confidential client secret
 *  - tokens are AES-256-GCM encrypted before they touch the database and
 *    never appear in redirects, audits, logs, or error messages
 */
import { GOOGLE_SOURCE_TYPES, newId, nowIso, toJson, type GoogleSourceType, type SourceCategory } from '@donna/core';
import { createDefaultRegistry } from '@donna/connectors';
import type { Db, OauthTokensTable } from '@donna/db';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { AppConfig } from '../config.js';
import type { AuditService, IngestionService, TokensService } from '../context.js';
import { encryptSecret } from '../lib/crypto.js';
import { badRequest } from '../lib/http-errors.js';
import {
  buildAuthorizeUrl,
  clearStateCookie,
  createPkcePair,
  randomToken,
  readStateCookie,
  setStateCookie,
  statesMatch,
  validateReturnTo,
} from '../lib/oauth.js';

export const SOURCE_STATE_COOKIE = 'donna_oauth_source';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Least-privilege scope per source (always combined with 'openid email'). */
const SOURCE_SCOPES: Record<GoogleSourceType, string> = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  'google-drive': 'https://www.googleapis.com/auth/drive.metadata.readonly',
  'google-calendar': 'https://www.googleapis.com/auth/calendar.readonly',
};

const SOURCE_LABELS: Record<GoogleSourceType, string> = {
  gmail: 'Gmail',
  'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar',
};

const SOURCE_CATEGORIES: Record<GoogleSourceType, SourceCategory> = {
  gmail: 'email',
  'google-drive': 'storage',
  'google-calendar': 'calendar',
};

function isGoogleSourceType(value: unknown): value is GoogleSourceType {
  return typeof value === 'string' && (GOOGLE_SOURCE_TYPES as readonly string[]).includes(value);
}

/** Web-app redirect target: relative in single-origin deploys, absolute in dev. */
function webRedirect(config: AppConfig, path: string): string {
  if (config.env.DONNA_PUBLIC_DIR) return path;
  return `${config.env.DONNA_WEB_ORIGIN.replace(/\/$/, '')}${path}`;
}

function appendQuery(path: string, queryString: string): string {
  return path.includes('?') ? `${path}&${queryString}` : `${path}?${queryString}`;
}

// ---------- Google id_token verification (jose, JWKS fetched via fetch) ----------

let jwksCache: { keySet: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Test hook: drop the cached Google JWKS. */
export function resetGoogleJwksCache(): void {
  jwksCache = null;
}

async function googleKeySet(): Promise<ReturnType<typeof createLocalJWKSet>> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keySet;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('failed to load Google JWKS');
  const jwks = (await res.json()) as JSONWebKeySet;
  jwksCache = { keySet: createLocalJWKSet(jwks), fetchedAt: Date.now() };
  return jwksCache.keySet;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

/**
 * Identify the granting Google account: verify the id_token (preferred) or
 * fall back to the OIDC userinfo endpoint. Returns null when neither yields
 * a (sub, email) pair.
 */
async function identifyGoogleAccount(
  tokens: GoogleTokenResponse,
  clientId: string,
): Promise<{ sub: string; email: string } | null> {
  if (tokens.id_token) {
    try {
      const { payload } = await jwtVerify(tokens.id_token, await googleKeySet(), {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: clientId,
      });
      if (typeof payload.sub === 'string' && typeof payload.email === 'string') {
        return { sub: payload.sub, email: payload.email };
      }
    } catch {
      // Unverifiable id_token: fall through to userinfo.
    }
  }
  if (!tokens.access_token) return null;
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { sub?: string; email?: string };
    if (typeof info.sub === 'string' && typeof info.email === 'string') {
      return { sub: info.sub, email: info.email };
    }
  } catch {
    // Network failure identifying the account.
  }
  return null;
}

// ---------- Routes ----------

export interface SourceOauthDeps {
  db: Db;
  config: AppConfig;
  audit: AuditService;
  services: {
    ingestion: Pick<IngestionService, 'syncAccount'>;
    tokens: Pick<TokensService, 'isOauthAccount'>;
  };
}

export function registerSourceOauthRoutes(app: FastifyInstance, deps: SourceOauthDeps): void {
  const { db, config, audit, services } = deps;
  // Connector descriptors (capabilities copied onto new oauth accounts).
  const registry = createDefaultRegistry();

  const redirectUri = (): string => `${config.publicUrl}/api/sources/oauth/google/callback`;

  // -- Start: 302 to Google consent (session required via the global hook) ----

  app.get('/api/sources/oauth/google/:sourceType/start', async (request, reply) => {
    const { sourceType } = request.params as { sourceType: string };
    if (!isGoogleSourceType(sourceType)) {
      throw badRequest(`Unknown Google source type '${sourceType}'`);
    }
    const clientId = config.env.GOOGLE_CLIENT_ID;
    const clientSecret = config.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw badRequest('Google OAuth is not configured', 'not_configured');
    }

    const query = (request.query ?? {}) as { returnTo?: string };
    const returnTo = query.returnTo === undefined ? '/settings' : validateReturnTo(query.returnTo);

    const state = randomToken();
    const pkce = createPkcePair();
    setStateCookie(
      reply,
      SOURCE_STATE_COOKIE,
      {
        state,
        codeVerifier: pkce.verifier,
        returnTo,
        intent: 'source',
        userId: request.userId,
        sourceType,
        issuedAt: nowIso(),
      },
      { sameSite: 'lax', secure: config.env.DONNA_COOKIE_SECURE },
    );

    const url = buildAuthorizeUrl(GOOGLE_AUTHORIZE_URL, {
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: `${SOURCE_SCOPES[sourceType]} openid email`,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    return reply.redirect(url, 302);
  });

  // -- Callback: store encrypted grant, ensure account, kick a sync ----------

  app.get('/api/sources/oauth/google/callback', async (request, reply) => {
    const query = (request.query ?? {}) as { state?: string; code?: string; error?: string };
    const payload = readStateCookie(request, SOURCE_STATE_COOKIE);
    clearStateCookie(reply, SOURCE_STATE_COOKIE); // single-use
    const returnTo = validateReturnTo(payload?.returnTo ?? '/settings');

    const fail = (code: string) =>
      reply.redirect(webRedirect(config, appendQuery(returnTo, `sourceError=${code}`)), 302);

    if (query.error) return fail('oauth_denied');
    if (!payload || !statesMatch(payload.state, query.state)) return fail('oauth_state_mismatch');
    // The flow is bound to the user who started it.
    if (payload.intent !== 'source' || !payload.userId || payload.userId !== request.userId) {
      return fail('oauth_failed');
    }
    const sourceType = payload.sourceType;
    if (!isGoogleSourceType(sourceType) || !query.code) return fail('oauth_failed');
    const clientId = config.env.GOOGLE_CLIENT_ID;
    const clientSecret = config.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return fail('oauth_failed');

    try {
      // Code -> tokens (PKCE verifier + confidential client secret).
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: query.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code',
          ...(payload.codeVerifier ? { code_verifier: payload.codeVerifier } : {}),
        }).toString(),
      });
      if (!tokenRes.ok) return fail('oauth_failed');
      const tokens = (await tokenRes.json()) as GoogleTokenResponse;
      if (!tokens.access_token) return fail('oauth_failed');

      // The user can untick scopes on the consent screen.
      const grantedScopes =
        typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter(Boolean) : [];
      if (!grantedScopes.includes(SOURCE_SCOPES[sourceType])) return fail('scope_denied');

      const identity = await identifyGoogleAccount(tokens, clientId);
      if (!identity) return fail('oauth_failed');

      const existing = await db
        .selectFrom('oauthTokens')
        .selectAll()
        .where('userId', '=', request.userId)
        .where('provider', '=', 'google')
        .where('sourceType', '=', sourceType)
        .executeTakeFirst();

      // Reauthorization must come from the SAME Google account as the
      // original grant — never silently swap the underlying mailbox/drive.
      if (existing?.providerAccountId && existing.providerAccountId !== identity.sub) {
        return fail('wrong_account');
      }

      const now = nowIso();
      const accessTokenEncrypted = encryptSecret(tokens.access_token, config.tokenEncryptionKey);
      const accessTokenExpiresAt = new Date(
        Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ).toISOString();
      // Google omits refresh_token on silent re-consent; keep the old one.
      const refreshTokenEncrypted = tokens.refresh_token
        ? encryptSecret(tokens.refresh_token, config.tokenEncryptionKey)
        : (existing?.refreshTokenEncrypted ?? null);

      let tokenRowId: string;
      if (existing) {
        tokenRowId = existing.id;
        await db
          .updateTable('oauthTokens')
          .set({
            providerAccountId: identity.sub,
            providerEmail: identity.email,
            grantedScopes: toJson(grantedScopes),
            accessTokenEncrypted,
            refreshTokenEncrypted,
            accessTokenExpiresAt,
            status: 'active',
            lastRefreshedAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where('id', '=', existing.id)
          .execute();
      } else {
        tokenRowId = newId('tok');
        await db
          .insertInto('oauthTokens')
          .values({
            id: tokenRowId,
            workspaceId: request.workspaceId,
            userId: request.userId,
            provider: 'google',
            sourceType,
            sourceAccountId: null,
            providerAccountId: identity.sub,
            providerEmail: identity.email,
            grantedScopes: toJson(grantedScopes),
            accessTokenEncrypted,
            refreshTokenEncrypted,
            accessTokenExpiresAt,
            status: 'active',
            lastRefreshedAt: now,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      }

      const accountId = await ensureSourceAccount({
        db,
        services,
        workspaceId: request.workspaceId,
        userId: request.userId,
        sourceType,
        tokenRowId,
        existingToken: existing,
        grantedScopes,
        providerEmail: identity.email,
        registry,
        now,
      });

      await db
        .updateTable('oauthTokens')
        .set({ sourceAccountId: accountId, updatedAt: nowIso() })
        .where('id', '=', tokenRowId)
        .execute();

      // Initial sync is fire-and-forget; the redirect must not wait on it.
      void services.ingestion
        .syncAccount(request.workspaceId, accountId, { mode: 'full', triggeredBy: 'connect' })
        .catch(() => {
          // Sync failures surface on the account row / connector runs.
        });

      await audit.log({
        workspaceId: request.workspaceId,
        userId: request.userId,
        eventType: 'source.oauth_connected',
        actor: 'user',
        targetType: 'source_account',
        targetId: accountId,
        summary: `Authorized ${SOURCE_LABELS[sourceType]} via Google OAuth`,
        metadata: { sourceType, scopes: grantedScopes },
      });

      return reply.redirect(
        webRedirect(config, appendQuery(returnTo, `connected=${sourceType}`)),
        302,
      );
    } catch {
      // Never 500 a browser navigation; nothing sensitive in the redirect.
      return fail('oauth_failed');
    }
  });
}

/** Find-or-create the sourceAccounts row backing an OAuth grant. */
async function ensureSourceAccount(opts: {
  db: Db;
  services: SourceOauthDeps['services'];
  workspaceId: string;
  userId: string;
  sourceType: GoogleSourceType;
  tokenRowId: string;
  existingToken: OauthTokensTable | undefined;
  grantedScopes: string[];
  providerEmail: string;
  registry: ReturnType<typeof createDefaultRegistry>;
  now: string;
}): Promise<string> {
  const { db, services, workspaceId, sourceType, tokenRowId, grantedScopes, now } = opts;

  // Prefer the account already linked to this grant, then any oauth-authRef
  // account for this token row.
  let account =
    opts.existingToken?.sourceAccountId !== undefined &&
    opts.existingToken?.sourceAccountId !== null
      ? await db
          .selectFrom('sourceAccounts')
          .select(['id', 'authRef'])
          .where('id', '=', opts.existingToken.sourceAccountId)
          .where('workspaceId', '=', workspaceId)
          .executeTakeFirst()
      : undefined;
  if (!account) {
    account = await db
      .selectFrom('sourceAccounts')
      .select(['id', 'authRef'])
      .where('workspaceId', '=', workspaceId)
      .where('provider', '=', sourceType)
      .where('authRef', '=', `oauth:${tokenRowId}`)
      .executeTakeFirst();
  }

  if (account && services.tokens.isOauthAccount(account.authRef)) {
    await db
      .updateTable('sourceAccounts')
      .set({
        status: 'connected',
        lastError: null,
        scopes: toJson(grantedScopes),
        authRef: `oauth:${tokenRowId}`,
        updatedAt: now,
      })
      .where('id', '=', account.id)
      .execute();
    return account.id;
  }

  const descriptor = opts.registry.get(sourceType)?.descriptor;
  const accountId = newId('acc');
  await db
    .insertInto('sourceAccounts')
    .values({
      id: accountId,
      workspaceId,
      userId: opts.userId,
      provider: sourceType,
      category: SOURCE_CATEGORIES[sourceType],
      displayName: `${SOURCE_LABELS[sourceType]} (${opts.providerEmail})`,
      status: 'connected',
      authRef: `oauth:${tokenRowId}`,
      scopes: toJson(grantedScopes),
      capabilities: toJson(descriptor?.capabilities ?? []),
      settings: toJson({}),
      lastSyncAt: null,
      syncCursor: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return accountId;
}
