import { createHmac } from 'node:crypto';
import {
  newId,
  nowIso,
  OAUTH_LOGIN_PROVIDERS,
  type OauthLoginProvider,
} from '@jarvis/core';
import type { Db } from '@jarvis/db';
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from 'jose';
import type { AppConfig } from '../../config.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  randomToken,
  sha256Base64Url,
  validateReturnTo,
  type OauthStatePayload,
} from '../../lib/oauth.js';
import { provisionUser } from '../users.js';

/**
 * OAuth LOGIN providers (Google / Facebook / Apple) — authentication only,
 * never data access. One config-driven module: each provider declares its
 * authorize/token endpoints, scopes, and a profile() normalizer that maps the
 * provider response onto a common OauthProfile. resolveOauthLogin() then maps
 * a profile onto Jarvis users/authAccounts with account-takeover protections.
 *
 * Security invariants:
 *  - id_tokens are ALWAYS verified with jose against the provider JWKS
 *    (issuer + audience + nonce); claims are only read from verified tokens.
 *  - authorization codes / access tokens / id_tokens are never logged,
 *    persisted, or put into Error messages.
 *  - unverified provider emails NEVER link to an existing local account.
 */

export interface OauthProfile {
  provider: OauthLoginProvider;
  /** The provider's stable subject ('sub' claim / graph id). */
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ProfileContext {
  config: AppConfig;
  state: OauthStatePayload;
  /** Apple form_post 'user' field (JSON; sent on first login only). */
  userField?: string;
}

type TokenResponse = Record<string, unknown>;

export interface LoginProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  isConfigured(config: AppConfig): boolean;
  authorizeParams(
    config: AppConfig,
    redirectUri: string,
    payload: OauthStatePayload,
  ): Record<string, string>;
  fetchToken(
    config: AppConfig,
    redirectUri: string,
    code: string,
    payload: OauthStatePayload,
  ): Promise<TokenResponse>;
  profile(tokens: TokenResponse, ctx: ProfileContext): Promise<OauthProfile>;
}

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/** Remote JWKS resolvers are cached per URL (jose caches the keys inside). */
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByUrl.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, set);
  }
  return set;
}

async function verifyIdToken(
  idToken: unknown,
  jwksUrl: string,
  issuer: string | string[],
  audience: string,
): Promise<JWTPayload> {
  if (typeof idToken !== 'string' || idToken.length === 0) throw new Error('missing_id_token');
  const { payload } = await jwtVerify(idToken, jwksFor(jwksUrl), { issuer, audience });
  return payload;
}

/** OIDC replay protection: the verified nonce claim must equal the state nonce. */
function requireNonce(claims: JWTPayload, state: OauthStatePayload): void {
  if (!state.nonce || claims.nonce !== state.nonce) throw new Error('nonce_mismatch');
}

/** email_verified arrives as boolean (Google) or the string 'true' (Apple). */
function truthyClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

async function postForm(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  // Status only — the response body could echo the authorization code.
  if (!res.ok) throw new Error(`oauth_token_http_${res.status}`);
  return (await res.json()) as TokenResponse;
}

async function getJson(url: URL): Promise<TokenResponse> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`oauth_http_${res.status}`);
  return (await res.json()) as TokenResponse;
}

/** Facebook requires HMAC-SHA256(access_token, app_secret) on server calls. */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Apple's client_secret is a short-lived ES256 JWT minted per token call. */
export async function mintAppleClientSecret(config: AppConfig): Promise<string> {
  const key = await importPKCS8(config.env.APPLE_PRIVATE_KEY ?? '', 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.env.APPLE_KEY_ID ?? '' })
    .setIssuer(config.env.APPLE_TEAM_ID ?? '')
    .setSubject(config.env.APPLE_CLIENT_ID ?? '')
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

/** Apple sends `user` (JSON {name:{firstName,lastName}}) on FIRST login only. */
export function parseAppleUserField(userField: string | undefined): string | null {
  if (!userField) return null;
  try {
    const parsed = JSON.parse(userField) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed?.name?.firstName, parsed?.name?.lastName]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim());
    return parts.length > 0 ? parts.join(' ') : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const LOGIN_PROVIDERS: Record<OauthLoginProvider, LoginProviderConfig> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'openid email profile',
    isConfigured: (config) => !!(config.env.GOOGLE_CLIENT_ID && config.env.GOOGLE_CLIENT_SECRET),
    authorizeParams: (config, redirectUri, payload) => ({
      client_id: config.env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: payload.state,
      nonce: payload.nonce ?? '',
      code_challenge: sha256Base64Url(payload.codeVerifier ?? ''),
      code_challenge_method: 'S256',
      // No access_type=offline: this is login only, we never want a refresh
      // token here (data access is the separate per-source authorization).
    }),
    fetchToken: (config, redirectUri, code, payload) =>
      postForm('https://oauth2.googleapis.com/token', {
        code,
        client_id: config.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: config.env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: payload.codeVerifier ?? '',
      }),
    profile: async (tokens, ctx) => {
      const claims = await verifyIdToken(
        tokens.id_token,
        GOOGLE_JWKS_URL,
        ['https://accounts.google.com', 'accounts.google.com'],
        ctx.config.env.GOOGLE_CLIENT_ID ?? '',
      );
      requireNonce(claims, ctx.state);
      if (!claims.sub) throw new Error('missing_subject');
      const email = optionalString(claims.email);
      return {
        provider: 'google',
        providerAccountId: String(claims.sub),
        email: email ? email.toLowerCase() : null,
        emailVerified: truthyClaim(claims.email_verified),
        displayName: optionalString(claims.name),
        avatarUrl: optionalString(claims.picture),
      };
    },
  },

  facebook: {
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    scopes: 'email,public_profile',
    isConfigured: (config) =>
      !!(config.env.FACEBOOK_CLIENT_ID && config.env.FACEBOOK_CLIENT_SECRET),
    authorizeParams: (config, redirectUri, payload) => ({
      client_id: config.env.FACEBOOK_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email,public_profile',
      state: payload.state,
    }),
    fetchToken: (config, redirectUri, code) => {
      const url = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
      url.searchParams.set('client_id', config.env.FACEBOOK_CLIENT_ID ?? '');
      url.searchParams.set('client_secret', config.env.FACEBOOK_CLIENT_SECRET ?? '');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('code', code);
      return getJson(url);
    },
    profile: async (tokens, ctx) => {
      const accessToken = optionalString(tokens.access_token);
      if (!accessToken) throw new Error('missing_access_token');
      const url = new URL('https://graph.facebook.com/v19.0/me');
      url.searchParams.set('fields', 'id,name,email,picture.width(256)');
      url.searchParams.set('access_token', accessToken);
      url.searchParams.set(
        'appsecret_proof',
        appSecretProof(accessToken, ctx.config.env.FACEBOOK_CLIENT_SECRET ?? ''),
      );
      const me = (await getJson(url)) as {
        id?: unknown;
        name?: unknown;
        email?: unknown;
        picture?: { data?: { url?: unknown } };
      };
      if (!me.id) throw new Error('missing_subject');
      const email = optionalString(me.email);
      return {
        provider: 'facebook',
        providerAccountId: String(me.id),
        email: email ? email.toLowerCase() : null,
        // Facebook only returns an email when it is confirmed on the account.
        emailVerified: email !== null,
        displayName: optionalString(me.name),
        avatarUrl: optionalString(me.picture?.data?.url),
      };
    },
  },

  apple: {
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scopes: 'name email',
    isConfigured: (config) =>
      !!(
        config.env.APPLE_CLIENT_ID &&
        config.env.APPLE_TEAM_ID &&
        config.env.APPLE_KEY_ID &&
        config.env.APPLE_PRIVATE_KEY
      ),
    authorizeParams: (config, redirectUri, payload) => ({
      client_id: config.env.APPLE_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'name email',
      response_mode: 'form_post',
      state: payload.state,
      nonce: payload.nonce ?? '',
    }),
    fetchToken: async (config, redirectUri, code) => {
      const clientSecret = await mintAppleClientSecret(config);
      return postForm('https://appleid.apple.com/auth/token', {
        client_id: config.env.APPLE_CLIENT_ID ?? '',
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
    },
    profile: async (tokens, ctx) => {
      const claims = await verifyIdToken(
        tokens.id_token,
        APPLE_JWKS_URL,
        'https://appleid.apple.com',
        ctx.config.env.APPLE_CLIENT_ID ?? '',
      );
      requireNonce(claims, ctx.state);
      if (!claims.sub) throw new Error('missing_subject');
      const email = optionalString(claims.email);
      return {
        provider: 'apple',
        providerAccountId: String(claims.sub),
        email: email ? email.toLowerCase() : null,
        emailVerified: truthyClaim(claims.email_verified),
        displayName: parseAppleUserField(ctx.userField),
        avatarUrl: null,
      };
    },
  },
};

export function isLoginProvider(value: unknown): value is OauthLoginProvider {
  return typeof value === 'string' && (OAUTH_LOGIN_PROVIDERS as readonly string[]).includes(value);
}

export function isProviderConfigured(provider: OauthLoginProvider, config: AppConfig): boolean {
  return LOGIN_PROVIDERS[provider].isConfigured(config);
}

/** Redirect URI registered with the provider, built from the public API URL. */
export function loginRedirectUri(config: AppConfig, provider: OauthLoginProvider): string {
  return `${config.publicUrl}/api/auth/oauth/${provider}/callback`;
}

/**
 * Fresh state payload for a login/link flow: random state, PKCE verifier for
 * Google, nonce for the OIDC providers, validated returnTo.
 */
export function createLoginStatePayload(
  provider: OauthLoginProvider,
  opts: { intent: 'login' | 'link'; returnTo?: unknown; userId?: string },
): OauthStatePayload {
  const fallback = opts.intent === 'link' ? '/settings' : '/';
  const returnTo =
    typeof opts.returnTo === 'string' && opts.returnTo.length > 0
      ? validateReturnTo(opts.returnTo)
      : fallback;
  const payload: OauthStatePayload = {
    state: randomToken(32),
    intent: opts.intent,
    returnTo,
    issuedAt: nowIso(),
  };
  if (opts.userId) payload.userId = opts.userId;
  if (provider === 'google') payload.codeVerifier = createPkcePair().verifier;
  if (provider === 'google' || provider === 'apple') payload.nonce = randomToken(16);
  return payload;
}

/** Authorize URL the /start route 302s to. Pure: derives everything from the payload. */
export function buildStartRedirect(
  provider: OauthLoginProvider,
  config: AppConfig,
  payload: OauthStatePayload,
): string {
  const def = LOGIN_PROVIDERS[provider];
  return buildAuthorizeUrl(
    def.authorizeUrl,
    def.authorizeParams(config, loginRedirectUri(config, provider), payload),
  );
}

/** Exchange the callback code and normalize the provider profile. */
export async function exchangeLoginCode(
  provider: OauthLoginProvider,
  config: AppConfig,
  code: string,
  ctx: { state: OauthStatePayload; userField?: string },
): Promise<OauthProfile> {
  const def = LOGIN_PROVIDERS[provider];
  const tokens = await def.fetchToken(config, loginRedirectUri(config, provider), code, ctx.state);
  return def.profile(tokens, { config, state: ctx.state, userField: ctx.userField });
}

// ---------------------------------------------------------------------------
// Profile -> Jarvis user resolution
// ---------------------------------------------------------------------------

export interface ResolveOauthCtx {
  intent: 'login' | 'link';
  /** Session user id — required for 'link' intent. */
  userId?: string;
  signupEnabled: boolean;
  authMode: 'local' | 'password';
}

export type OauthLoginError =
  | 'no_email'
  | 'email_unverified'
  | 'email_in_use'
  | 'already_linked'
  | 'signup_disabled'
  | 'oauth_failed';

export interface OauthUserRef {
  id: string;
  email: string;
  name: string;
}

export type OauthLoginOutcome =
  | {
      status: 'ok';
      user: OauthUserRef;
      /** Workspace to bind the session to. Null for 'link' (session already has one). */
      workspaceId: string | null;
      /** A brand-new user + workspace were provisioned. */
      createdUser: boolean;
      /** A new authAccounts row was inserted (audit 'auth.oauth_linked'). */
      linkedAccount: boolean;
    }
  | { status: 'error'; code: OauthLoginError };

async function workspaceIdForUser(db: Db, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('workspaces')
    .select(['id'])
    .where('ownerUserId', '=', userId)
    .orderBy('createdAt', 'asc')
    .executeTakeFirst();
  return row?.id ?? null;
}

async function insertAuthAccount(
  db: Db,
  userId: string,
  profile: OauthProfile,
  now: string,
  opts: { touchLogin: boolean },
): Promise<void> {
  await db
    .insertInto('authAccounts')
    .values({
      id: newId('aac'),
      userId,
      provider: profile.provider,
      providerAccountId: profile.providerAccountId,
      email: profile.email,
      emailVerified: profile.emailVerified ? 1 : 0,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      lastLoginAt: opts.touchLogin ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

/** Refresh profile fields, never erasing values the provider stopped sending
 * (e.g. Apple only sends the name on the very first login). */
async function refreshAuthAccount(
  db: Db,
  accountId: string,
  profile: OauthProfile,
  now: string,
  opts: { touchLogin: boolean },
): Promise<void> {
  const patch: Record<string, string | number | null> = { updatedAt: now };
  if (profile.email) {
    patch.email = profile.email;
    patch.emailVerified = profile.emailVerified ? 1 : 0;
  }
  if (profile.displayName) patch.displayName = profile.displayName;
  if (profile.avatarUrl) patch.avatarUrl = profile.avatarUrl;
  if (opts.touchLogin) patch.lastLoginAt = now;
  await db.updateTable('authAccounts').set(patch).where('id', '=', accountId).execute();
}

async function touchUserLogin(
  db: Db,
  user: { id: string; avatarUrl: string | null },
  profile: OauthProfile,
  now: string,
): Promise<void> {
  const patch: Record<string, string> = { lastLoginAt: now, updatedAt: now };
  if (profile.avatarUrl && !user.avatarUrl) patch.avatarUrl = profile.avatarUrl;
  await db.updateTable('users').set(patch).where('id', '=', user.id).execute();
}

/**
 * Map a verified provider profile onto Jarvis users/authAccounts.
 *
 * 'link': attach the identity to ctx.userId (already-linked-elsewhere fails).
 * 'login': existing authAccount wins; otherwise link by VERIFIED email match,
 * or provision a new user when signup is allowed AND the provider email is
 * verified. An unverified provider email never links to an existing account
 * (account-takeover protection) and never provisions a new one.
 */
export async function resolveOauthLogin(
  db: Db,
  profile: OauthProfile,
  ctx: ResolveOauthCtx,
): Promise<OauthLoginOutcome> {
  const now = nowIso();
  const account = await db
    .selectFrom('authAccounts')
    .selectAll()
    .where('provider', '=', profile.provider)
    .where('providerAccountId', '=', profile.providerAccountId)
    .executeTakeFirst();

  if (ctx.intent === 'link') {
    if (!ctx.userId) return { status: 'error', code: 'oauth_failed' };
    if (account && account.userId !== ctx.userId) {
      return { status: 'error', code: 'already_linked' };
    }
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'name'])
      .where('id', '=', ctx.userId)
      .executeTakeFirst();
    if (!user) return { status: 'error', code: 'oauth_failed' };
    if (account) {
      await refreshAuthAccount(db, account.id, profile, now, { touchLogin: false });
      return { status: 'ok', user, workspaceId: null, createdUser: false, linkedAccount: false };
    }
    await insertAuthAccount(db, ctx.userId, profile, now, { touchLogin: false });
    return { status: 'ok', user, workspaceId: null, createdUser: false, linkedAccount: true };
  }

  // intent 'login'
  if (account) {
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', account.userId)
      .executeTakeFirst();
    if (!user) return { status: 'error', code: 'oauth_failed' };
    const workspaceId = await workspaceIdForUser(db, user.id);
    if (!workspaceId) return { status: 'error', code: 'oauth_failed' };
    await refreshAuthAccount(db, account.id, profile, now, { touchLogin: true });
    await touchUserLogin(db, user, profile, now);
    return {
      status: 'ok',
      user: { id: user.id, email: user.email, name: user.name },
      workspaceId,
      createdUser: false,
      linkedAccount: false,
    };
  }

  if (!profile.email) return { status: 'error', code: 'no_email' };
  const email = profile.email.toLowerCase();
  const existing = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst();

  if (existing) {
    // Account-takeover protection: only a VERIFIED provider email may attach
    // a brand-new OAuth identity to an existing local account.
    if (!profile.emailVerified) return { status: 'error', code: 'email_unverified' };
    const workspaceId = await workspaceIdForUser(db, existing.id);
    if (!workspaceId) return { status: 'error', code: 'oauth_failed' };
    await insertAuthAccount(db, existing.id, profile, now, { touchLogin: true });
    await touchUserLogin(db, existing, profile, now);
    return {
      status: 'ok',
      user: { id: existing.id, email: existing.email, name: existing.name },
      workspaceId,
      createdUser: false,
      linkedAccount: true,
    };
  }

  // Local mode is single-user and reports signupEnabled=false by construction:
  // an unknown OAuth identity must never provision a second user there either.
  if (!ctx.signupEnabled) {
    return { status: 'error', code: 'signup_disabled' };
  }
  // Provisioning a brand-new user requires a VERIFIED provider email — never
  // create an account around an address the provider has not confirmed.
  if (!profile.emailVerified) return { status: 'error', code: 'email_unverified' };
  let provisioned: Awaited<ReturnType<typeof provisionUser>>;
  try {
    provisioned = await provisionUser(db, {
      email,
      name: profile.displayName ?? email.split('@')[0] ?? 'Jarvis User',
      emailVerified: profile.emailVerified,
      avatarUrl: profile.avatarUrl,
    });
  } catch (err) {
    const code = (err as Error).message === 'email_taken' ? 'email_in_use' : 'oauth_failed';
    return { status: 'error', code };
  }
  await insertAuthAccount(db, provisioned.user.id, profile, now, { touchLogin: true });
  await db
    .updateTable('users')
    .set({ lastLoginAt: now, updatedAt: now })
    .where('id', '=', provisioned.user.id)
    .execute();
  return {
    status: 'ok',
    user: {
      id: provisioned.user.id,
      email: provisioned.user.email,
      name: provisioned.user.name,
    },
    workspaceId: provisioned.workspace.id,
    createdUser: true,
    linkedAccount: false,
  };
}
