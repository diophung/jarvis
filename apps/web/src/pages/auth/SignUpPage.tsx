import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Button, Input, LoadingPane } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { AuthShell, Divider, OauthButtons } from './shared.js';

export function SignUpPage() {
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
      setError('Passwords do not match.');
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
      setError(err instanceof ApiError ? err.message : 'Sign-up failed — please try again.');
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title="Create your Donna account">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="signup-name" className="block text-sm font-medium mb-1">
            Name
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
            Email
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
            Password
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
            Confirm password
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
            className="mt-0.5 accent-donna-600"
          />
          <span>I acknowledge the Terms of Service and Privacy Policy.</span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={submitting}>
          Create account
        </Button>
      </form>

      {providers.length > 0 && (
        <>
          <Divider label="or" />
          <OauthButtons providers={providers} intent="signup" returnTo="/" />
        </>
      )}

      <p className="mt-5 text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link to="/signin" className="text-donna-700 underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
