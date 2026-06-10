/** Shared building blocks for the Settings tabs. */
import type { LlmProviderConfig, UserPreference } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Copy, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Card } from '../../components/ui.js';
import { api } from '../../lib/api.js';

// ---------- API response shapes (per docs/api-contract.md) ----------

export interface SystemInfo {
  version: string;
  dbDialect: 'sqlite' | 'postgres';
  storageDriver: 'local' | 's3';
  authMode: 'local' | 'password';
  demoSeed: boolean;
  dataDir: string;
}

/** Providers as returned by the API: key is masked, never the ciphertext. */
export type LlmProviderPublic = Omit<LlmProviderConfig, 'apiKeyEncrypted'> & {
  hasStoredKey: boolean;
  apiKeyMasked: string | null;
};

export function useSystem() {
  return useQuery({
    queryKey: ['system'],
    queryFn: () => api.get<SystemInfo>('/api/system'),
    staleTime: 5 * 60 * 1000,
  });
}

// ---------- Preferences helpers ----------

export function usePreferences() {
  return useQuery({
    queryKey: ['preferences'],
    queryFn: () => api.get<{ items: UserPreference[] }>('/api/preferences'),
  });
}

export function useSetPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api.put<{ preference: UserPreference }>(`/api/preferences/${encodeURIComponent(key)}`, {
        value,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preferences'] }),
  });
}

export function prefValue(items: UserPreference[] | undefined, key: string): unknown {
  return items?.find((p) => p.key === key)?.value;
}

export function prefStrings(items: UserPreference[] | undefined, key: string): string[] {
  const v = prefValue(items, key);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// ---------- Layout primitives ----------

export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className={clsx('flex items-start justify-between gap-4', 'mb-4')}>
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="text-sm text-ink-muted mt-0.5 max-w-xl">{description}</p>}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </Card>
  );
}

/** Labelled form field. Don't nest interactive labels (e.g. Switch) inside. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('block', className)}>
      <span className="block text-[13px] font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-muted mt-1">{hint}</span>}
    </label>
  );
}

/** Definition-list style row used on Security / Deployment tabs. */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 py-2 border-b border-surface-border/60 last:border-b-0 text-sm">
      <span className="w-36 shrink-0 text-ink-muted">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

// ---------- Tag editor (emails, topics, keywords) ----------

export function TagEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const v = draft.trim().replace(/,+$/, '');
    setDraft('');
    if (!v || value.includes(v)) return;
    onChange([...value, v]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-surface-border bg-surface-raised px-2 py-1.5 focus-within:ring-2 focus-within:ring-donna-300">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[12px] text-ink"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="text-ink-faint hover:text-red-600"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="flex-1 min-w-[140px] bg-transparent text-sm outline-none placeholder:text-ink-faint py-0.5"
      />
    </div>
  );
}

// ---------- Toggle chips (multi-select over a small option set) ----------

export function ToggleChips({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(o.value)}
            className={clsx(
              'rounded-full border px-3 py-1 text-[13px] transition-colors',
              active
                ? 'border-donna-400 bg-donna-100 text-donna-900 font-medium'
                : 'border-surface-border bg-surface-raised text-ink-muted hover:border-donna-300 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Copyable code block ----------

export function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="bg-surface-sunken border border-surface-border rounded-lg px-3 py-2.5 pr-10 text-[13px] overflow-x-auto whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        title="Copy to clipboard"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
          } catch {
            // clipboard unavailable (e.g. insecure context) — ignore
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-2 right-2 text-ink-faint hover:text-ink"
      >
        {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}
