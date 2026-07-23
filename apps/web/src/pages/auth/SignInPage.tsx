import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, LoadingPane } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';
import { safeReturnTo, useAuth } from '../../lib/auth.js';
import { AuthShell, Divider, OauthButtons } from './shared.js';

export function SignInPage() {
  const { t } = useTranslation();
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
        <p className="text-sm text-ink-muted text-center">{t('auth.signin.localModeRedirect')}</p>
      </AuthShell>
    );
  }

  // ?error= codes come from the OAuth callback redirect (docs/api-contract.md,
  // "OAuth login"); unknown codes fall back to the generic failure copy.
  const oauthError =
    oauthErrorCode != null
      ? t(`auth.signin.errors.${oauthErrorCode}`, { defaultValue: t('auth.signin.failed') })
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
        setFormError(t('auth.signin.invalidCredentials'));
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError(t('auth.signin.tooManyAttempts'));
      } else {
        setFormError(t('auth.signin.failed'));
      }
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title={t('auth.signin.title')}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="signin-email" className="block text-sm font-medium mb-1">
            {t('common.email')}
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
            {t('common.password')}
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
          {t('auth.signin.submit')}
        </Button>
      </form>

      <Divider label={t('auth.divider.or')} />
      <OauthButtons providers={providers} intent="signin" returnTo={returnTo} />

      <div className="mt-5 space-y-1 text-center text-sm text-ink-muted">
        {methods?.signupEnabled && (
          <p>
            {t('auth.signin.newToJarvis')}{' '}
            <Link to="/signup" className="text-jarvis-700 underline underline-offset-2">
              {t('auth.signin.createAccount')}
            </Link>
          </p>
        )}
        <p>
          <Link to="/forgot-password" className="text-jarvis-700 underline underline-offset-2">
            {t('auth.signin.forgotPassword')}
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
