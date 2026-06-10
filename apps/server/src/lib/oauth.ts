import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Shared OAuth 2.0 / OIDC flow helpers: state + PKCE generation, the signed
 * short-lived state cookie that carries flow context across the redirect, and
 * returnTo validation. Used by both the login flows (google/facebook/apple)
 * and the Google data-source authorization flows.
 *
 * Security invariants:
 *  - state is a 32-byte random value, single-use (cookie cleared on callback)
 *  - the cookie is signed (@fastify/cookie) and expires after 10 minutes
 *  - returnTo only ever resolves to an in-app path, never an absolute URL
 *  - nothing in this module logs or returns tokens/codes
 */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

/** PKCE code_verifier + S256 code_challenge pair. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: sha256Base64Url(verifier) };
}

/**
 * Restrict post-login redirects to in-app paths: must start with a single
 * '/', no scheme, no '//', no backslashes. Anything else falls back to '/'.
 */
export function validateReturnTo(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  if (input.includes('\\') || input.includes('\r') || input.includes('\n')) return '/';
  if (input.includes('://')) return '/';
  return input;
}

export function buildAuthorizeUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Context carried across the OAuth redirect in the signed state cookie. */
export interface OauthStatePayload {
  state: string;
  codeVerifier?: string;
  nonce?: string;
  returnTo?: string;
  /** 'login' creates/links + signs in; 'link' attaches to userId; 'source' authorizes a data source. */
  intent: 'login' | 'link' | 'source';
  /** Bound user for 'link' and 'source' intents — callback must match the session user. */
  userId?: string;
  /** For 'source' intent: which Google source is being authorized. */
  sourceType?: string;
  issuedAt: string;
}

const STATE_COOKIE_MAX_AGE_S = 600;

export interface StateCookieOptions {
  /** Apple's form_post callback is a cross-site POST: requires SameSite=None; Secure. */
  sameSite: 'lax' | 'none';
  secure: boolean;
}

export function setStateCookie(
  reply: FastifyReply,
  name: string,
  payload: OauthStatePayload,
  opts: StateCookieOptions,
): void {
  reply.setCookie(name, JSON.stringify(payload), {
    path: '/api',
    httpOnly: true,
    signed: true,
    maxAge: STATE_COOKIE_MAX_AGE_S,
    sameSite: opts.sameSite,
    // SameSite=None requires Secure or browsers drop the cookie.
    secure: opts.sameSite === 'none' ? true : opts.secure,
  });
}

export function readStateCookie(request: FastifyRequest, name: string): OauthStatePayload | null {
  const raw = request.cookies[name];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    const payload = JSON.parse(unsigned.value) as OauthStatePayload;
    if (typeof payload.state !== 'string' || payload.state.length < 16) return null;
    const ageMs = Date.now() - Date.parse(payload.issuedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > STATE_COOKIE_MAX_AGE_S * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearStateCookie(reply: FastifyReply, name: string): void {
  reply.clearCookie(name, { path: '/api' });
}

/** Constant-time-ish state comparison (lengths first, then strict equality). */
export function statesMatch(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && a === b;
}
