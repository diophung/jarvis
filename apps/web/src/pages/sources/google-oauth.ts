/**
 * Helpers for the per-source Google OAuth UI (Connected Sources).
 *
 * Connect / Reconnect buttons are real browser navigations (`<a href>`), not
 * fetches — the server 302s straight to Google's consent screen. URLs are
 * built with `apiUrl` (lib/auth.tsx), addressing the API the same way the
 * XHR client in `lib/api.ts` does.
 */
import { GOOGLE_SOURCE_TYPES, type GoogleSourceType } from '@donna/core';
import { apiUrl } from '../../lib/auth.js';

export function isGoogleSourceType(provider: string): provider is GoogleSourceType {
  return (GOOGLE_SOURCE_TYPES as readonly string[]).includes(provider);
}

/**
 * Start (or, for `needs_auth` accounts, re-run) the Google consent flow for a
 * data source. `returnTo` is the in-app path the callback should land on.
 */
export function googleSourceStartUrl(sourceType: GoogleSourceType, returnTo: string): string {
  return apiUrl(
    `/api/sources/oauth/google/${sourceType}/start?returnTo=${encodeURIComponent(returnTo)}`,
  );
}

export const GOOGLE_SOURCE_LABELS: Record<GoogleSourceType, string> = {
  gmail: 'Gmail',
  'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar',
};

/** One-line, plain-language explanation of what each grant lets Donna do. */
export const GOOGLE_SOURCE_ACCESS: Record<GoogleSourceType, string> = {
  gmail:
    'Donna can read message subjects, senders, and snippets — it cannot send email without your approval.',
  'google-drive':
    'Donna can see file names, owners, and activity (metadata only) — it cannot open or download file contents.',
  'google-calendar':
    'Donna can read your calendar events (read-only) — it cannot create or change events.',
};

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

/** Compact display label for a granted scope chip. */
export function scopeLabel(scope: string): string {
  return scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope;
}

/** Friendly copy for `?sourceError=<code>` OAuth callback failures. */
export function sourceErrorMessage(code: string): string {
  switch (code) {
    case 'scope_denied':
      return 'Donna needs the requested read-only permission to connect this source.';
    case 'wrong_account':
      return 'Reconnect with the SAME Google account this source was originally connected with.';
    case 'oauth_denied':
      return 'Connection was cancelled.';
    default:
      return 'Connection failed — try again.';
  }
}

/** Success copy for `?connected=<sourceType>` OAuth callback landings. */
export function sourceConnectedMessage(sourceType: string): string {
  const label = isGoogleSourceType(sourceType) ? GOOGLE_SOURCE_LABELS[sourceType] : sourceType;
  return `${label} connected — first sync started.`;
}

/** Anchor styled like the primary Button (for browser-navigation flows). */
export const oauthPrimaryLinkClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors ' +
  'text-[13px] px-2.5 py-1.5 bg-donna-600 text-white hover:bg-donna-700 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-donna-400';
