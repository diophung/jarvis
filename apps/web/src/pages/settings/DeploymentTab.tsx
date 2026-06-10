import { Container, Server } from 'lucide-react';
import { Badge, LoadingPane } from '../../components/ui.js';
import { CopyBlock, InfoRow, SettingsSection, useSystem } from './shared.js';

const DOCKER_RUN =
  'docker build -t donna . && docker run -d --name donna -p 3001:3001 ' +
  '-v donna-data:/data -e DONNA_SECRET="$(openssl rand -hex 32)" donna';

const ENV_VARS: { name: string; description: string }[] = [
  { name: 'DONNA_SECRET', description: 'Signs sessions and encrypts stored API keys. Required in production.' },
  { name: 'DONNA_PORT', description: 'API + web port (default 3001).' },
  { name: 'DONNA_DATA_DIR', description: 'Where SQLite and uploaded files live (default ./data).' },
  { name: 'DATABASE_URL', description: 'Set a postgres:// URL to use managed Postgres instead of SQLite.' },
  { name: 'DONNA_STORAGE_DRIVER', description: 'File storage: local (default) or s3.' },
  { name: 'DONNA_AUTH_MODE', description: 'local (single-user auto-login) or password.' },
  { name: 'DONNA_OWNER_EMAIL / DONNA_OWNER_PASSWORD', description: 'Initial owner account; password required in password mode.' },
  { name: 'DONNA_DEMO_SEED', description: 'Seed a demo workspace with mock sources on first boot (default true).' },
  { name: 'ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY', description: 'Bootstrap cloud AI providers on first boot.' },
  { name: 'DONNA_LOCAL_LLM_BASE_URL / DONNA_LOCAL_LLM_MODEL', description: 'Bootstrap a local OpenAI-compatible provider (Ollama, vLLM, SGLang).' },
];

export function DeploymentTab() {
  const { data: system, isLoading } = useSystem();

  if (isLoading) return <LoadingPane label="Loading system info…" />;

  return (
    <div className="space-y-5">
      <SettingsSection
        title="This instance"
        description="How this copy of Donna is currently running."
      >
        <InfoRow label="Version">{system?.version ?? 'unknown'}</InfoRow>
        <InfoRow label="Database">
          <span className="inline-flex items-center gap-2">
            <Badge tone={system?.dbDialect === 'postgres' ? 'blue' : 'green'}>
              {system?.dbDialect ?? 'sqlite'}
            </Badge>
            <span className="text-ink-muted">
              {system?.dbDialect === 'postgres'
                ? 'Managed Postgres — suitable for cloud deployments.'
                : 'Local SQLite file — zero setup, lives in your data directory.'}
            </span>
          </span>
        </InfoRow>
        <InfoRow label="File storage">
          <span className="inline-flex items-center gap-2">
            <Badge tone={system?.storageDriver === 's3' ? 'blue' : 'green'}>
              {system?.storageDriver ?? 'local'}
            </Badge>
            <span className="text-ink-muted">
              {system?.storageDriver === 's3'
                ? 'Object storage (S3-compatible).'
                : 'Local filesystem.'}
            </span>
          </span>
        </InfoRow>
        <InfoRow label="Auth mode">{system?.authMode ?? 'local'}</InfoRow>
        <InfoRow label="Data directory">
          <code className="bg-surface-sunken rounded px-1">{system?.dataDir ?? './data'}</code>
        </InfoRow>
        <InfoRow label="Demo seed">
          {system?.demoSeed
            ? 'On — a demo workspace with mock sources was seeded on first boot.'
            : 'Off'}
        </InfoRow>
      </SettingsSection>

      <SettingsSection
        title="Run it yourself"
        description="One container holds the API, worker, and web UI. SQLite and uploads persist in the donna-data volume."
      >
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1.5">
              <Container className="h-3.5 w-3.5 text-ink-faint" /> Docker Compose (recommended)
            </div>
            <CopyBlock code="docker compose up --build" />
            <p className="text-xs text-ink-muted mt-1.5">
              Opens on http://localhost:3001. Optional profiles:{' '}
              <code className="bg-surface-sunken rounded px-1">--profile postgres</code> and{' '}
              <code className="bg-surface-sunken rounded px-1">--profile ollama</code> for local
              inference.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1.5">
              <Server className="h-3.5 w-3.5 text-ink-faint" /> Plain Docker
            </div>
            <CopyBlock code={DOCKER_RUN} />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Environment reference"
        description="The variables that matter most. Every value has a safe local default — see .env.example in the repo root for the full list."
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-faint uppercase tracking-wide">
              <th className="font-medium pb-2 pr-4">Variable</th>
              <th className="font-medium pb-2">What it does</th>
            </tr>
          </thead>
          <tbody>
            {ENV_VARS.map((v) => (
              <tr key={v.name} className="border-t border-surface-border/60 align-top">
                <td className="py-2 pr-4 whitespace-nowrap">
                  <code className="bg-surface-sunken rounded px-1 text-[12px]">{v.name}</code>
                </td>
                <td className="py-2 text-ink-muted">{v.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsSection>
    </div>
  );
}
