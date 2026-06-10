import type { LlmCallLog, LlmProviderKind, LlmTask } from '@donna/core';
import { LLM_TASKS } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Cloud,
  HardDrive,
  KeyRound,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Input, LoadingPane, Modal, Select, Switch } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { useLlmStatus } from '../../lib/hooks.js';
import { timeAgo } from '../../lib/format.js';
import type { LlmProviderPublic } from './shared.js';
import { Field, SettingsSection } from './shared.js';

// ---------- Constants ----------

const KIND_LABELS: Record<LlmProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openai_compatible: 'OpenAI-compatible',
  mock: 'Mock',
};

const TASK_META: Record<LlmTask, { label: string; description: string }> = {
  chat: { label: 'Chat', description: 'Conversations with Donna' },
  summarization: { label: 'Summarization', description: 'Condensing emails, threads, and documents' },
  digest: { label: 'Digest generation', description: 'Daily debrief writing' },
  classification: { label: 'Classification', description: 'Prioritizing and categorizing items' },
  embedding: { label: 'Embeddings', description: 'Vectors that power semantic search' },
};

interface ProviderPreset {
  label: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
  isLocal: boolean;
}

const PRESETS: ProviderPreset[] = [
  { label: 'Anthropic Claude', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: '', isLocal: false },
  { label: 'OpenAI', name: 'OpenAI', kind: 'openai', baseUrl: '', isLocal: false },
  { label: 'Google Gemini', name: 'Google Gemini', kind: 'gemini', baseUrl: '', isLocal: false },
  { label: 'Ollama (local)', name: 'Ollama', kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1', isLocal: true },
  { label: 'vLLM (local)', name: 'vLLM', kind: 'openai_compatible', baseUrl: 'http://localhost:8000/v1', isLocal: true },
  { label: 'SGLang (local)', name: 'SGLang', kind: 'openai_compatible', baseUrl: 'http://localhost:30000/v1', isLocal: true },
  { label: 'Other OpenAI-compatible', name: '', kind: 'openai_compatible', baseUrl: '', isLocal: false },
];

type RoutesResponse = {
  routes: Record<LlmTask, { providerConfigId: string | null; modelOverride: string | null } | null>;
};

interface HealthResult {
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

function useProviders() {
  return useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => api.get<{ items: LlmProviderPublic[] }>('/api/llm/providers'),
  });
}

// ---------- Status banner ----------

function StatusBanner() {
  const { data } = useLlmStatus();
  if (!data) return null;
  if (data.demoMode) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <Sparkles className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          <span className="font-medium">Demo mode</span> — responses are mocked until you add a
          provider. Add a local model (Ollama, vLLM, SGLang) or a cloud key below.
        </div>
      </div>
    );
  }
  const assigned = LLM_TASKS.filter((t) => data.tasks[t] !== null);
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
      <div>
        <span className="font-medium">AI is configured</span> — {assigned.length} of{' '}
        {LLM_TASKS.length} tasks have a model.{' '}
        {data.tasks.chat && (
          <span>
            Chat runs on {data.tasks.chat.providerName} ({data.tasks.chat.model})
            {data.tasks.chat.isLocal ? ', locally on your machine' : ''}.
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- Add / edit provider modal ----------

function ProviderFormModal({
  provider,
  onClose,
}: {
  provider: LlmProviderPublic | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form, setForm] = useState({
    name: provider?.name ?? '',
    kind: (provider?.kind ?? 'openai_compatible') as LlmProviderKind,
    baseUrl: provider?.baseUrl ?? '',
    model: provider?.model ?? '',
    apiKey: '',
    apiKeyEnv: provider?.apiKeyEnv ?? '',
    temperature: provider?.temperature != null ? String(provider.temperature) : '',
    maxTokens: provider?.maxTokens != null ? String(provider.maxTokens) : '',
    timeoutMs: provider?.timeoutMs != null ? String(provider.timeoutMs) : '',
    embeddingModel: provider?.embeddingModel ?? '',
    supportsEmbeddings: provider ? provider.supportsEmbeddings === 1 : false,
    isLocal: provider ? provider.isLocal === 1 : false,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        kind: form.kind,
        model: form.model.trim(),
        baseUrl: form.baseUrl.trim() || null,
        apiKeyEnv: form.apiKeyEnv.trim() || null,
        temperature: form.temperature === '' ? null : Number(form.temperature),
        maxTokens: form.maxTokens === '' ? null : Number(form.maxTokens),
        timeoutMs: form.timeoutMs === '' ? null : Number(form.timeoutMs),
        isLocal: form.isLocal,
        supportsEmbeddings: form.supportsEmbeddings,
        embeddingModel: form.embeddingModel.trim() || null,
      };
      if (form.apiKey) payload.apiKey = form.apiKey;
      if (!provider) {
        // POST: omit empty optionals entirely
        for (const k of Object.keys(payload)) {
          if (payload[k] === null) delete payload[k];
        }
        return api.post('/api/llm/providers', payload);
      }
      return api.patch(`/api/llm/providers/${provider.id}`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llm-providers'] });
      qc.invalidateQueries({ queryKey: ['llm-status'] });
      qc.invalidateQueries({ queryKey: ['llm-routes'] });
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose} title={provider ? `Edit ${provider.name}` : 'Add AI provider'} wide>
      <div className="space-y-4">
        {!provider && (
          <div>
            <div className="text-[13px] font-medium mb-1.5">Start from a preset</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setPreset(p.label);
                    setForm((f) => ({
                      ...f,
                      name: p.name || f.name,
                      kind: p.kind,
                      baseUrl: p.baseUrl,
                      isLocal: p.isLocal,
                    }));
                  }}
                  className={clsx(
                    'rounded-full border px-3 py-1 text-[13px] transition-colors',
                    preset === p.label
                      ? 'border-donna-400 bg-donna-100 text-donna-900 font-medium'
                      : 'border-surface-border text-ink-muted hover:border-donna-300 hover:text-ink',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="My model server"
            />
          </Field>
          <Field label="Kind">
            <Select
              value={form.kind}
              onChange={(v) => set('kind', v as LlmProviderKind)}
              options={(['anthropic', 'openai', 'gemini', 'openai_compatible'] as const).map(
                (k) => ({ value: k, label: KIND_LABELS[k] }),
              )}
              className="w-full"
            />
          </Field>
        </div>

        <Field label="Base URL" hint="Leave blank to use the provider's default endpoint.">
          <Input
            value={form.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder="http://localhost:11434/v1"
          />
        </Field>

        <Field label="Model" hint="Whatever model id your endpoint serves — e.g. llama3.1:8b.">
          <Input
            value={form.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder="model id"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="API key"
            hint={
              provider?.hasStoredKey
                ? 'Stored encrypted. Leave blank to keep the current key.'
                : 'Stored encrypted on this machine — never shown again.'
            }
          >
            <Input
              type="password"
              value={form.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder={provider?.apiKeyMasked ?? 'sk-…'}
              autoComplete="off"
            />
          </Field>
          <Field
            label="API key env var"
            hint="Reference an env var by name (recommended) — the key never touches the database."
          >
            <Input
              value={form.apiKeyEnv}
              onChange={(e) => set('apiKeyEnv', e.target.value)}
              placeholder="ANTHROPIC_API_KEY"
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          className="flex items-center gap-1 text-[13px] text-ink-muted hover:text-ink"
        >
          {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Advanced settings
        </button>
        {showAdvanced && (
          <div className="space-y-4 rounded-lg border border-surface-border p-3">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Temperature">
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={form.temperature}
                  onChange={(e) => set('temperature', e.target.value)}
                  placeholder="0.7"
                />
              </Field>
              <Field label="Max tokens">
                <Input
                  type="number"
                  value={form.maxTokens}
                  onChange={(e) => set('maxTokens', e.target.value)}
                  placeholder="4096"
                />
              </Field>
              <Field label="Timeout (ms)">
                <Input
                  type="number"
                  value={form.timeoutMs}
                  onChange={(e) => set('timeoutMs', e.target.value)}
                  placeholder="60000"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Switch
                checked={form.supportsEmbeddings}
                onChange={(v) => set('supportsEmbeddings', v)}
                label="Supports embeddings"
              />
              <Switch
                checked={form.isLocal}
                onChange={(v) => set('isLocal', v)}
                label="Runs locally"
              />
            </div>
            {form.supportsEmbeddings && (
              <Field label="Embedding model">
                <Input
                  value={form.embeddingModel}
                  onChange={(e) => set('embeddingModel', e.target.value)}
                  placeholder="nomic-embed-text"
                />
              </Field>
            )}
          </div>
        )}

        {mutation.isError && (
          <p className="text-sm text-red-600">{(mutation.error as Error).message}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!form.name.trim() || !form.model.trim()}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Save provider
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Provider card ----------

function ProviderCard({
  provider,
  onEdit,
}: {
  provider: LlmProviderPublic;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['llm-providers'] });
    qc.invalidateQueries({ queryKey: ['llm-status'] });
  };
  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch(`/api/llm/providers/${provider.id}`, { enabled }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/llm/providers/${provider.id}`),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['llm-routes'] });
    },
  });
  const checkHealth = useMutation({
    mutationFn: () => api.post<HealthResult>(`/api/llm/providers/${provider.id}/health`),
    onSuccess: (res) => setHealth(res),
    onError: (err) => setHealth({ ok: false, message: (err as Error).message }),
  });

  const keyState = provider.apiKeyMasked ? (
    <span>Key {provider.apiKeyMasked}</span>
  ) : provider.apiKeyEnv ? (
    <span>
      Key from env <code className="bg-surface-sunken rounded px-1">{provider.apiKeyEnv}</code>
    </span>
  ) : (
    <span>No API key</span>
  );

  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{provider.name}</span>
        <Badge tone="neutral">{KIND_LABELS[provider.kind]}</Badge>
        {provider.isLocal === 1 ? (
          <Badge tone="green">
            <HardDrive className="h-3 w-3" /> Runs locally — data stays on your machine
          </Badge>
        ) : (
          <Badge tone="blue">
            <Cloud className="h-3 w-3" /> Cloud — data is sent to {KIND_LABELS[provider.kind]}
          </Badge>
        )}
        <div className="ml-auto">
          <Switch
            checked={provider.enabled === 1}
            onChange={(v) => toggleEnabled.mutate(v)}
            label={provider.enabled === 1 ? 'Enabled' : 'Disabled'}
          />
        </div>
      </div>
      {toggleEnabled.isError && (
        <p className="mt-2 text-sm text-red-600">
          Couldn’t {provider.enabled === 1 ? 'disable' : 'enable'} this provider —{' '}
          {(toggleEnabled.error as Error).message}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
        <span>
          Model <span className="text-ink font-medium">{provider.model}</span>
        </span>
        {provider.baseUrl && <span className="text-ink-faint">{provider.baseUrl}</span>}
        <span className="inline-flex items-center gap-1">
          <KeyRound className="h-3.5 w-3.5" /> {keyState}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" loading={checkHealth.isPending} onClick={() => checkHealth.mutate()}>
          <Activity className="h-3.5 w-3.5" /> Check health
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-red-600 hover:text-red-700"
          loading={del.isPending}
          onClick={() => {
            if (window.confirm(`Remove provider “${provider.name}”?`)) del.mutate();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </Button>
        {health && (
          <span
            className={clsx(
              'text-[13px]',
              health.ok ? 'text-emerald-700' : 'text-red-600',
            )}
          >
            {health.ok ? (
              <>Healthy · {health.latencyMs ?? '?'}ms{health.message ? ` — ${health.message}` : ''}</>
            ) : (
              <>Health check failed{health.message ? ` — ${health.message}` : ''}</>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- Task routing ----------

function ModelOverrideInput({
  current,
  onCommit,
}: {
  current: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const commit = () => {
    if (draft !== null && draft.trim() !== current) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <Input
      value={value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      placeholder="provider default"
      className="max-w-[180px] py-1.5"
    />
  );
}

function TaskRouting() {
  const qc = useQueryClient();
  const { data: providers } = useProviders();
  const { data: routesData, isLoading } = useQuery({
    queryKey: ['llm-routes'],
    queryFn: () => api.get<RoutesResponse>('/api/llm/routes'),
  });
  const setRoute = useMutation({
    mutationFn: ({
      task,
      providerConfigId,
      modelOverride,
    }: {
      task: LlmTask;
      providerConfigId: string | null;
      modelOverride: string | null;
    }) => api.put(`/api/llm/routes/${task}`, { providerConfigId, modelOverride }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llm-routes'] });
      qc.invalidateQueries({ queryKey: ['llm-status'] });
    },
  });

  const providerOptions = [
    { value: '', label: 'Default' },
    ...(providers?.items ?? []).map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <SettingsSection
      title="Task routing"
      description="Mix and match: e.g. a local model for summaries, a stronger cloud model for your debrief."
    >
      {isLoading ? (
        <LoadingPane label="Loading routes…" />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-faint uppercase tracking-wide">
              <th className="font-medium pb-2 pr-4">Task</th>
              <th className="font-medium pb-2 pr-4">Provider</th>
              <th className="font-medium pb-2">Model override</th>
            </tr>
          </thead>
          <tbody>
            {LLM_TASKS.map((task) => {
              const route = routesData?.routes[task] ?? null;
              return (
                <tr key={task} className="border-t border-surface-border/60" data-testid={`route-${task}`}>
                  <td className="py-2.5 pr-4">
                    <div className="font-medium">{TASK_META[task].label}</div>
                    <div className="text-xs text-ink-muted">{TASK_META[task].description}</div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <Select
                      value={route?.providerConfigId ?? ''}
                      onChange={(v) =>
                        setRoute.mutate({
                          task,
                          providerConfigId: v === '' ? null : v,
                          modelOverride: route?.modelOverride ?? null,
                        })
                      }
                      options={providerOptions}
                      className="py-1.5"
                    />
                  </td>
                  <td className="py-2.5">
                    <ModelOverrideInput
                      current={route?.modelOverride ?? ''}
                      onCommit={(v) =>
                        setRoute.mutate({
                          task,
                          providerConfigId: route?.providerConfigId ?? null,
                          modelOverride: v === '' ? null : v,
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </SettingsSection>
  );
}

// ---------- Recent calls ----------

function RecentCalls() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['llm-calls'],
    queryFn: () => api.get<{ items: LlmCallLog[] }>('/api/llm/calls?limit=50'),
    enabled: open,
  });
  const statusTone = (s: LlmCallLog['status']) =>
    s === 'success' ? 'green' : s === 'timeout' ? 'amber' : 'red';
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[13px] text-ink-muted hover:text-ink"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Recent model calls
      </button>
      {open && (
        <div className="mt-3">
          {isLoading ? (
            <LoadingPane label="Loading calls…" />
          ) : (data?.items ?? []).length === 0 ? (
            <p className="text-sm text-ink-muted">No model calls recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-faint uppercase tracking-wide">
                  <th className="font-medium pb-2 pr-3">Time</th>
                  <th className="font-medium pb-2 pr-3">Task</th>
                  <th className="font-medium pb-2 pr-3">Model</th>
                  <th className="font-medium pb-2 pr-3">Status</th>
                  <th className="font-medium pb-2 pr-3 text-right">Latency</th>
                  <th className="font-medium pb-2 text-right">Tokens in / out</th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((c) => (
                  <tr key={c.id} className="border-t border-surface-border/60">
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">
                      {timeAgo(c.createdAt)}
                    </td>
                    <td className="py-2 pr-3">{TASK_META[c.task].label}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.model}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.latencyMs}ms</td>
                    <td className="py-2 text-right tabular-nums text-ink-muted">
                      {c.inputTokens ?? '—'} / {c.outputTokens ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Tab ----------

export function ProvidersTab() {
  const { data: providers, isLoading } = useProviders();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LlmProviderPublic | null>(null);

  return (
    <div className="space-y-5">
      <StatusBanner />

      <SettingsSection
        title="Providers"
        description="Donna works with local inference servers and cloud APIs. Local providers keep your data on your machine."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add provider
          </Button>
        }
      >
        {isLoading ? (
          <LoadingPane label="Loading providers…" />
        ) : (providers?.items ?? []).length === 0 ? (
          <div className="text-sm text-ink-muted flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            No providers yet. Add one to leave demo mode — Ollama is the easiest local start.
          </div>
        ) : (
          <div className="space-y-3">
            {(providers?.items ?? []).map((p) => (
              <ProviderCard key={p.id} provider={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </SettingsSection>

      <TaskRouting />
      <RecentCalls />

      {adding && <ProviderFormModal provider={null} onClose={() => setAdding(false)} />}
      {editing && <ProviderFormModal provider={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
