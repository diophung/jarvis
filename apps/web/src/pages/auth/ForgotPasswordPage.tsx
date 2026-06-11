import { Link } from 'react-router-dom';
import { AuthShell } from './shared.js';

/**
 * Donna is self-hosted and has no email infrastructure, so there is no
 * reset-link flow to pretend to have. Be honest: an admin with server access
 * resets the password from the command line.
 */
export function ForgotPasswordPage() {
  return (
    <AuthShell title="Reset your password">
      <div className="space-y-3 text-sm text-ink-muted">
        <p>
          Donna is self-hosted and doesn&rsquo;t send email, so there&rsquo;s no reset link we can
          send you.
        </p>
        <p>
          Instead, whoever runs your Donna server (maybe you!) can set a new password from the
          server machine:
        </p>
        <pre className="rounded-lg border border-surface-border bg-surface-sunken p-3 text-[12px] leading-relaxed text-ink overflow-x-auto">
          <code>
            pnpm --filter @donna/server exec tsx src/scripts/reset-password.ts &lt;email&gt; &lt;new
            password&gt;
          </code>
        </pre>
        <p>Once that&rsquo;s done, come back and sign in with the new password.</p>
      </div>
      <p className="mt-5 text-center text-sm">
        <Link to="/signin" className="text-donna-700 underline underline-offset-2">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
