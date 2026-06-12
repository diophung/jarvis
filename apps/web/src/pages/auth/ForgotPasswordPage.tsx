import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AuthShell } from './shared.js';

/**
 * Donna is self-hosted and has no email infrastructure, so there is no
 * reset-link flow to pretend to have. Be honest: an admin with server access
 * resets the password from the command line.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  return (
    <AuthShell title={t('auth.forgot.title')}>
      <div className="space-y-3 text-sm text-ink-muted">
        <p>{t('auth.forgot.intro1')}</p>
        <p>{t('auth.forgot.intro2')}</p>
        <pre className="rounded-lg border border-surface-border bg-surface-sunken p-3 text-[12px] leading-relaxed text-ink overflow-x-auto">
          <code>
            pnpm --filter @donna/server exec tsx src/scripts/reset-password.ts &lt;email&gt; &lt;new
            password&gt;
          </code>
        </pre>
        <p>{t('auth.forgot.intro3')}</p>
      </div>
      <p className="mt-5 text-center text-sm">
        <Link to="/signin" className="text-donna-700 underline underline-offset-2">
          {t('auth.forgot.backToSignIn')}
        </Link>
      </p>
    </AuthShell>
  );
}
