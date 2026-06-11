/** Shared pieces for the auth pages: centered shell, divider, OAuth buttons. */
import type { ReactNode } from 'react';
import { Card } from '../../components/ui.js';
import type { OauthLoginProvider } from '../../lib/auth.js';
import { apiUrl } from '../../lib/auth.js';

export function AuthShell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="h-8 w-8 rounded-lg bg-donna-600 text-white flex items-center justify-center font-semibold">
            D
          </div>
          <span className="text-lg font-semibold tracking-tight">Donna</span>
        </div>
        <Card className="p-6">
          {title && <h1 className="text-lg font-semibold mb-4 text-center">{title}</h1>}
          {children}
        </Card>
      </div>
    </div>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-ink-faint">
      <span className="h-px flex-1 bg-surface-border" aria-hidden="true" />
      {label}
      <span className="h-px flex-1 bg-surface-border" aria-hidden="true" />
    </div>
  );
}

const PROVIDER_LABELS: Record<OauthLoginProvider, string> = {
  google: 'Google',
  facebook: 'Facebook',
  apple: 'Apple',
};

function ProviderGlyph({ provider }: { provider: OauthLoginProvider }) {
  if (provider === 'google') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.17 3.57-8.81Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.96-1.07 7.93-2.91l-3.87-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.1A12 12 0 0 0 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.8.14-1.57.38-2.29v-3.1H1.29a12 12 0 0 0 0 10.78l4-3.1Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.29 6.61l4 3.1C6.23 6.88 8.88 4.77 12 4.77Z"
        />
      </svg>
    );
  }
  if (provider === 'facebook') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <path
          fill="#1877F2"
          d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3 1.79-4.67 4.53-4.67 1.31 0 2.68.24 2.68.24v2.95h-1.51c-1.49 0-1.95.92-1.95 1.87V12h3.32l-.53 3.47h-2.79v8.38A12 12 0 0 0 24 12Z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.36 12.76c-.02-2.3 1.88-3.4 1.96-3.45-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.83-.81-3-.79-1.55.02-2.97.9-3.77 2.28-1.6 2.78-.41 6.9 1.15 9.16.77 1.1 1.68 2.35 2.87 2.3 1.15-.05 1.59-.74 2.98-.74s1.78.74 3 .72c1.24-.02 2.02-1.12 2.78-2.23.87-1.28 1.23-2.53 1.25-2.59-.03-.01-2.4-.92-2.43-3.69ZM14.07 5.6c.63-.77 1.06-1.83.94-2.9-.91.04-2.01.61-2.66 1.37-.58.68-1.1 1.77-.96 2.81 1.02.08 2.05-.51 2.68-1.28Z"
      />
    </svg>
  );
}

/** All login providers Donna supports, in display order. */
const ALL_PROVIDERS: OauthLoginProvider[] = ['google', 'facebook', 'apple'];

/**
 * OAuth provider buttons. Always shows Google, Facebook, and Apple; providers
 * without server credentials render disabled with an explanation, configured
 * ones are plain anchors (not XHR) — the start route 302s to the provider's
 * consent screen, so the browser must navigate.
 */
export function OauthButtons({
  providers,
  intent,
  returnTo,
}: {
  /** Providers the server reports as configured (GET /api/auth/methods). */
  providers: OauthLoginProvider[];
  intent: 'signin' | 'signup';
  returnTo: string;
}) {
  const verb = intent === 'signup' ? 'Sign up with' : 'Continue with';
  const base =
    'flex w-full items-center justify-center gap-2 rounded-lg border border-surface-border bg-surface-raised px-3.5 py-2 text-sm font-medium';
  return (
    <div className="space-y-2">
      {ALL_PROVIDERS.map((p) => {
        const label = `${verb} ${PROVIDER_LABELS[p]}`;
        if (!providers.includes(p)) {
          return (
            <button
              key={p}
              type="button"
              disabled
              title={`${PROVIDER_LABELS[p]} sign-in isn't configured on this server yet — see docs/auth.md for setup.`}
              className={`${base} text-ink-faint opacity-60 cursor-not-allowed`}
            >
              <ProviderGlyph provider={p} />
              {label}
            </button>
          );
        }
        return (
          <a
            key={p}
            href={apiUrl(`/api/auth/oauth/${p}/start?returnTo=${encodeURIComponent(returnTo)}`)}
            className={`${base} text-ink hover:bg-surface-sunken transition-colors`}
          >
            <ProviderGlyph provider={p} />
            {label}
          </a>
        );
      })}
    </div>
  );
}
