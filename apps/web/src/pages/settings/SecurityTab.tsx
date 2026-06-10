/**
 * Account & security tab: sign-in methods (password), linked OAuth login
 * accounts, email verification, active sessions, plus deployment-level
 * security info (DONNA_SECRET warning, logging, data location).
 *
 * Endpoints per docs/api-contract.md "Auth & profile" / "OAuth login".
 */
import type { AuthAccount, OauthLoginProvider, User } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, EyeOff, FolderLock, KeySquare, MailCheck } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Badge, Button, Card, Input, LoadingPane } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';
import { apiUrl } from '../../lib/auth.js';
import { smartTime, timeAgo } from '../../lib/format.js';
import { useMe } from '../../lib/hooks.js';
import { CopyBlock, Field, InfoRow, SettingsSection, useSystem } from './shared.js';

// ---------- API shapes ----------

interface AuthMethods {
  authMode: 'local' | 'password';
  signupEnabled: boolean;
  oauthProviders: OauthLoginProvider[];
}

interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

const PROVIDER_LABELS: Record<OauthLoginProvider, string> = {
  google: 'Google',
  facebook: 'Facebook',
  apple: 'Apple',
};

/** OAuth link-start is a 302 to the provider — a real link, not a fetch. */
function linkStartUrl(provider: OauthLoginProvider): string {
  return apiUrl(`/api/auth/oauth/${provider}/start?link=1&returnTo=${encodeURIComponent('/settings')}`);
}

/** Anchor styled like the secondary Button (browser navigation, not fetch). */
const linkButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors ' +
  'text-[13px] px-2.5 py-1.5 bg-surface-raised border border-surface-border text-ink hover:bg-surface-sunken ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-donna-400';

/** Small monogram avatar for an OAuth provider (no brand assets needed). */
function ProviderMark({ provider }: { provider: string }) {
  return (
    <span className="h-8 w-8 rounded-full bg-surface-sunken text-ink-muted flex items-center justify-center text-sm font-semibold uppercase shrink-0">
      {provider.slice(0, 1)}
    </span>
  );
}

// ---------- (a) Sign-in methods ----------

function PasswordForm({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const change = useMutation({
    mutationFn: () =>
      api.post<{ ok: true }>(
        '/api/auth/password',
        hasPassword ? { currentPassword, newPassword } : { newPassword },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['auth-sessions'] });
      onDone();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!newPassword) return;
    change.mutate();
  };

  return (
    <form onSubmit={submit} className="mt-3 max-w-sm space-y-3">
      {hasPassword && (
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </Field>
      )}
      <Field label="New password">
        <Input
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </Field>
      <p className="text-xs text-ink-muted">
        Changing your password signs you out everywhere else.
      </p>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={newPassword === '' || (hasPassword && currentPassword === '')}
          loading={change.isPending}
        >
          Save password
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {change.isError && (
        <p className="text-sm text-red-600">{(change.error as Error).message}</p>
      )}
    </form>
  );
}

function SignInMethodsSection({
  user,
  authMode,
}: {
  user: User & { hasPassword?: boolean };
  authMode: 'local' | 'password';
}) {
  const hasPassword = Boolean(user.hasPassword);
  const [formOpen, setFormOpen] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  return (
    <SettingsSection
      title="Sign-in methods"
      description="How you prove it's you — and how access to this Donna instance is protected."
    >
      <InfoRow label="Auth mode">
        <span className="inline-flex items-center gap-2">
          <Badge tone={authMode === 'local' ? 'amber' : 'green'}>{authMode}</Badge>
          <span className="text-ink-muted">
            {authMode === 'local'
              ? 'Anyone who can reach this server is signed in automatically — fine on your own machine, not for shared hosts.'
              : 'Email and password are required to sign in.'}
          </span>
        </span>
      </InfoRow>
      <InfoRow label="Password">
        <span className="inline-flex items-center gap-2">
          <Badge tone={hasPassword ? 'green' : 'neutral'}>{hasPassword ? 'Set' : 'Not set'}</Badge>
          <span className="text-ink-muted">
            {hasPassword
              ? 'You can sign in with your email and password.'
              : 'No password yet — you sign in another way (e.g. an OAuth provider).'}
          </span>
        </span>
      </InfoRow>
      {!formOpen && (
        <div className="mt-3 flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => {
              setSavedNotice(false);
              setFormOpen(true);
            }}
          >
            {hasPassword ? 'Change password' : 'Set password'}
          </Button>
          {savedNotice && (
            <span className="text-sm text-emerald-700">
              Password updated — other sessions were signed out.
            </span>
          )}
        </div>
      )}
      {formOpen && (
        <PasswordForm
          hasPassword={hasPassword}
          onDone={() => {
            setFormOpen(false);
            setSavedNotice(true);
          }}
        />
      )}
      {authMode === 'local' && (
        <div className="mt-4">
          <p className="text-sm text-ink-muted mb-2">
            To require a password (recommended for any deployment others can reach), set these
            environment variables and restart:
          </p>
          <CopyBlock
            code={`DONNA_AUTH_MODE=password\nDONNA_OWNER_EMAIL=you@example.com\nDONNA_OWNER_PASSWORD=a-strong-password`}
          />
        </div>
      )}
    </SettingsSection>
  );
}

// ---------- (b) Linked accounts ----------

function LinkedAccountsSection() {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ['auth-accounts'],
    queryFn: () => api.get<{ items: AuthAccount[] }>('/api/auth/accounts'),
  });
  const methods = useQuery({
    queryKey: ['auth-methods'],
    queryFn: () => api.get<AuthMethods>('/api/auth/methods'),
  });
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const unlink = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/auth/accounts/${id}`),
    onSuccess: () => {
      setUnlinkError(null);
      qc.invalidateQueries({ queryKey: ['auth-accounts'] });
    },
    onError: (err) => {
      setUnlinkError(
        err instanceof ApiError && err.code === 'last_login_method'
          ? 'Set a password first — this is your only way to sign in.'
          : err instanceof Error
            ? err.message
            : 'Could not unlink this account.',
      );
    },
  });

  const linked = accounts.data?.items ?? [];
  const linkable = (methods.data?.oauthProviders ?? []).filter(
    (p) => !linked.some((a) => a.provider === p),
  );

  return (
    <SettingsSection
      title="Linked accounts"
      description="OAuth identities you can sign in with. Unlinking never deletes the provider account itself."
    >
      {accounts.isLoading && <LoadingPane label="Loading linked accounts…" />}
      {!accounts.isLoading && linked.length === 0 && (
        <p className="text-sm text-ink-muted">No OAuth accounts linked yet.</p>
      )}
      {linked.length > 0 && (
        <ul className="divide-y divide-surface-border/60">
          {linked.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-2.5 text-sm">
              <ProviderMark provider={a.provider} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {PROVIDER_LABELS[a.provider] ?? a.provider}
                  </span>
                  {a.email && <span className="text-ink-muted truncate">{a.email}</span>}
                </div>
                <p className="text-xs text-ink-muted mt-0.5">
                  {a.displayName ? `${a.displayName} · ` : ''}
                  Linked {timeAgo(a.createdAt)}
                  {a.lastLoginAt ? ` · Last used ${timeAgo(a.lastLoginAt)}` : ' · Never used'}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Unlink ${PROVIDER_LABELS[a.provider] ?? a.provider}`}
                loading={unlink.isPending && unlink.variables === a.id}
                onClick={() => unlink.mutate(a.id)}
              >
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      {unlinkError && <p className="text-sm text-red-600 mt-2">{unlinkError}</p>}
      {linkable.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {linkable.map((p) => (
            <a key={p} href={linkStartUrl(p)} className={linkButtonClass}>
              Link {PROVIDER_LABELS[p]}
            </a>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

// ---------- (c) Email verification ----------

function EmailVerificationSection({ user }: { user: User }) {
  const verified = Boolean(user.emailVerified);
  return (
    <SettingsSection title="Email verification" description="Status of your account email.">
      <div className="flex items-start gap-2.5 text-sm">
        <MailCheck className="h-4 w-4 mt-0.5 text-ink-faint shrink-0" />
        <p className="text-ink-muted">
          <span className="mr-2 align-middle">
            <Badge tone={verified ? 'green' : 'amber'}>
              {verified ? 'Verified' : 'Unverified'}
            </Badge>
          </span>
          <span className="font-medium text-ink">{user.email}</span>
          {' — '}
          {verified
            ? 'this address was confirmed (e.g. by signing in with an OAuth provider that verified it).'
            : 'this address is verified automatically when you sign in with an OAuth provider that has confirmed it.'}
        </p>
      </div>
    </SettingsSection>
  );
}

// ---------- (d) Sessions ----------

function SessionsSection() {
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api.get<{ items: SessionSummary[] }>('/api/auth/sessions'),
  });
  const [revokedCount, setRevokedCount] = useState<number | null>(null);

  const revokeOne = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth-sessions'] }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.del<{ ok: true; revoked: number }>('/api/auth/sessions'),
    onSuccess: (res) => {
      setRevokedCount(res.revoked);
      qc.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
  });

  const items = sessions.data?.items ?? [];

  return (
    <SettingsSection
      title="Sessions"
      description="Everywhere you're signed in right now."
      actions={
        <Button
          size="sm"
          loading={revokeOthers.isPending}
          onClick={() => revokeOthers.mutate()}
        >
          Sign out everywhere else
        </Button>
      }
    >
      {sessions.isLoading && <LoadingPane label="Loading sessions…" />}
      {revokedCount !== null && (
        <p className="text-sm text-emerald-700 mb-2">
          Signed out {revokedCount} other {revokedCount === 1 ? 'session' : 'sessions'}.
        </p>
      )}
      {(revokeOthers.isError || revokeOne.isError) && (
        <p className="text-sm text-red-600 mb-2">
          {((revokeOthers.error ?? revokeOne.error) as Error).message}
        </p>
      )}
      {!sessions.isLoading && items.length === 0 && (
        <p className="text-sm text-ink-muted">No active sessions.</p>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 pr-4">Created</th>
                <th className="py-1.5 pr-4">Last seen</th>
                <th className="py-1.5 pr-4">Device</th>
                <th className="py-1.5 pr-4">IP</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-surface-border/60">
                  <td className="py-2 pr-4 whitespace-nowrap">{smartTime(s.createdAt)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-ink-muted">
                    {timeAgo(s.lastSeenAt)}
                  </td>
                  <td className="py-2 pr-4 max-w-[14rem]">
                    <span className="block truncate text-ink-muted" title={s.userAgent ?? ''}>
                      {s.userAgent ?? 'Unknown device'}
                    </span>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap text-ink-muted">{s.ip ?? '—'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {s.current ? (
                      <Badge tone="blue">This device</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Revoke session ${s.id}`}
                        loading={revokeOne.isPending && revokeOne.variables === s.id}
                        onClick={() => revokeOne.mutate(s.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}

// ---------- Tab ----------

export function SecurityTab() {
  const { data: me } = useMe();
  const { data: system, isLoading } = useSystem();

  if (isLoading || !me) return <LoadingPane label="Loading account & security…" />;

  const authMode = system?.authMode ?? me.authMode;
  // /api/me carries hasPassword instead of passwordHash (docs/api-contract.md).
  const user = me.user as User & { hasPassword?: boolean };

  return (
    <div className="space-y-5">
      <SignInMethodsSection user={user} authMode={authMode} />

      <LinkedAccountsSection />

      <EmailVerificationSection user={user} />

      <SessionsSection />

      <Card className="p-5 border-amber-200 bg-amber-50">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-700 shrink-0" />
          <div className="text-sm text-amber-900">
            <h2 className="font-semibold flex items-center gap-1.5">
              <KeySquare className="h-4 w-4" /> Set a real DONNA_SECRET
            </h2>
            <p className="mt-1.5">
              <code className="bg-amber-100 rounded px-1">DONNA_SECRET</code> signs your session
              cookie and encrypts API keys saved through this page. If it is unset, Donna falls
              back to a built-in development value — sessions can be forged and stored keys are not
              truly protected. Set a long random value before exposing Donna beyond your machine:
            </p>
            <div className="mt-2">
              <CopyBlock code={'DONNA_SECRET="$(openssl rand -hex 32)"'} />
            </div>
          </div>
        </div>
      </Card>

      <SettingsSection
        title="Logging & redaction"
        description="What Donna writes to its own logs."
      >
        <div className="flex items-start gap-2.5 text-sm">
          <EyeOff className="h-4 w-4 mt-0.5 text-ink-faint shrink-0" />
          <p className="text-ink-muted">
            Logs never contain secrets or full content. Audit entries and model-call records store
            summaries, counts, and sizes only — never API keys, passwords, OAuth tokens, message
            bodies, or attachments.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title="Data location" description="Where your data lives.">
        <div className="flex items-start gap-2.5 text-sm">
          <FolderLock className="h-4 w-4 mt-0.5 text-ink-faint shrink-0" />
          <div>
            <InfoRow label="Data directory">
              <code className="bg-surface-sunken rounded px-1">{system?.dataDir ?? './data'}</code>
            </InfoRow>
            <InfoRow label="Database">{system?.dbDialect ?? 'sqlite'}</InfoRow>
            <InfoRow label="File storage">{system?.storageDriver ?? 'local'}</InfoRow>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
