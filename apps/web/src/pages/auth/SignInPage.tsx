import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, LoadingPane } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';
import { safeReturnTo, useAuth } from '../../lib/auth.js';
import { AuthShell, Divider, OauthButtons } from './shared.js';

/**
 * Friendly copy for ?error= codes set by the OAuth callback redirect
 * (docs/api-contract.md, "OAuth login"). Never echo raw provider errors.
 */
const OAUTH_ERROR_COPY: Record<string, string> = {
  oauth_denied: 'Sign-in was cancelled.',
  oauth_state_mismatch: 'Sign-in failed — please try again.',
  oauth_failed: 'Sign-in failed — please try again.',
  email_unverified:
    'That email already has an account. Sign in with your password, then link this provider in Settings.',
  email_in_use:
    'That email already has an account. Sign in with your password, then link this provider in Settings.',
  already_linked: 'That account is already linked to a different user.',
  no_email: 'Your provider account has no email address.',
  signup_disabled: 'Sign-ups are disabled.',
};

export function SignInPage() {
  const { methods, authMode, loading, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const oauthErrorCode = params.get('error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isLocal = authMode === 'local';
  useEffect(() => {
    // Local single-user mode auto-logs in via /api/me — nothing to sign into.
    if (!loading && isLocal) navigate('/', { replace: true });
  }, [loading, isLocal, navigate]);

  if (loading) {
    return (
      <AuthShell>
        <LoadingPane />
      </AuthShell>
    );
  }

  if (isLocal) {
    return (
      <AuthShell>
        <p className="text-sm text-ink-muted text-center">
          Donna is running in local single-user mode — signing you in…
        </p>
      </AuthShell>
    );
  }

  const oauthError =
    oauthErrorCode != null
      ? (OAUTH_ERROR_COPY[oauthErrorCode] ?? 'Sign-in failed — please try again.')
      : null;
  const error = formError ?? oauthError;
  const providers = methods?.oauthProviders ?? [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      await refresh();
      navigate(returnTo, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setFormError('Invalid email or password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError('Too many attempts — try again in a few minutes.');
      } else {
        setFormError('Sign-in failed — please try again.');
      }
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title="Sign in to Donna">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="signin-email" className="block text-sm font-medium mb-1">
            Email
          </label>
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            required
            disabled={submitting}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="signin-password" className="block text-sm font-medium mb-1">
            Password
          </label>
          <Input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            required
            disabled={submitting}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={submitting}>
          Sign in
        </Button>
      </form>

      {providers.length > 0 && (
        <>
          <Divider label="or" />
          <OauthButtons providers={providers} intent="signin" returnTo={returnTo} />
        </>
      )}

      <div className="mt-5 space-y-1 text-center text-sm text-ink-muted">
        {methods?.signupEnabled && (
          <p>
            New to Donna?{' '}
            <Link to="/signup" className="text-donna-700 underline underline-offset-2">
              Create an account
            </Link>
          </p>
        )}
        <p>
          <Link to="/forgot-password" className="text-donna-700 underline underline-offset-2">
            Forgot password?
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
