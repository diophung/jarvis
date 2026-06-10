import { AlertTriangle, EyeOff, FolderLock, KeySquare } from 'lucide-react';
import { Badge, Card, LoadingPane } from '../../components/ui.js';
import { useMe } from '../../lib/hooks.js';
import { CopyBlock, InfoRow, SettingsSection, useSystem } from './shared.js';

export function SecurityTab() {
  const { data: me } = useMe();
  const { data: system, isLoading } = useSystem();

  if (isLoading || !me) return <LoadingPane label="Loading security info…" />;

  const authMode = system?.authMode ?? me.authMode;

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Sign-in"
        description="How access to this Donna instance is protected."
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
        {authMode === 'local' && (
          <div className="mt-3">
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
            summaries, counts, and sizes only — never API keys, message bodies, or attachments.
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
