import type { FormEvent } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Button, Input, LoadingPane } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { AuthShell, Divider, OauthButtons } from './shared.js';

export function SignUpPage() {
  const { t } = useTranslation();
  const { methods, authMode, loading, refresh } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) {
    return (
      <AuthShell>
        <LoadingPane />
      </AuthShell>
    );
  }

  // Local mode auto-logs in; when sign-ups are disabled there is nothing to
  // do here either way.
  if (authMode === 'local' || !methods?.signupEnabled) {
    return <Navigate to="/signin" replace />;
  }

  const providers = methods.oauthProviders;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(t('auth.signup.passwordsNoMatch'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/auth/register', { email, name, password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      // The server's registration error copy is intentionally generic (it
      // never reveals whether an account exists) — surface it verbatim.
      setError(err instanceof ApiError ? err.message : t('auth.signup.failed'));
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title={t('auth.signup.title')}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="signup-name" className="block text-sm font-medium mb-1">
            {t('auth.signup.name')}
          </label>
          <Input
            id="signup-name"
            type="text"
            autoComplete="name"
            required
            disabled={submitting}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="signup-email" className="block text-sm font-medium mb-1">
            {t('common.email')}
          </label>
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            required
            disabled={submitting}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="signup-password" className="block text-sm font-medium mb-1">
            {t('common.password')}
          </label>
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            disabled={submitting}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="signup-confirm" className="block text-sm font-medium mb-1">
            {t('auth.signup.confirmPassword')}
          </label>
          <Input
            id="signup-confirm"
            type="password"
            autoComplete="new-password"
            required
            disabled={submitting}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <label className="flex items-start gap-2 text-[13px] text-ink-muted">
          <input
            type="checkbox"
            required
            disabled={submitting}
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 accent-jarvis-600"
          />
          <span>{t('auth.signup.terms')}</span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={submitting}>
          {t('auth.signup.submit')}
        </Button>
      </form>

      <Divider label={t('auth.divider.or')} />
      <OauthButtons providers={providers} intent="signup" returnTo="/" />

      <p className="mt-5 text-center text-sm text-ink-muted">
        {t('auth.signup.haveAccount')}{' '}
        <Link to="/signin" className="text-jarvis-700 underline underline-offset-2">
          {t('auth.signup.signIn')}
        </Link>
      </p>
    </AuthShell>
  );
}
