/**
 * Learned Preferences: the explainability and control surface for the
 * self-learning subsystem. Shows everything Jarvis has learned, why, from
 * what evidence, at what confidence — with confirm / pin / edit / mark wrong /
 * delete controls. The good-assistant contract: "Based on these signals, I
 * think this matters to you. Here is why. Correct me anytime."
 */
import type {
  ContradictionReportEntry,
  LearnedPreference,
  LearningSignal,
  PreferenceCategory,
} from '@jarvis/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronDown, ChevronRight, GraduationCap, Pin, PinOff, Plus, RefreshCw, ThumbsDown, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingPane,
  PageHeader,
  Switch,
  Textarea,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/format.js';

const CATEGORY_LABELS: Record<PreferenceCategory, string> = {
  communication_style: 'Communication style',
  format: 'Formatting',
  people: 'People',
  topics: 'Topics',
  priorities: 'Priorities & goals',
  scheduling: 'Scheduling',
  decision_style: 'Decisions',
  workflow: 'Workflow',
};

const CATEGORY_ORDER: PreferenceCategory[] = [
  'communication_style',
  'format',
  'people',
  'topics',
  'priorities',
  'scheduling',
  'decision_style',
  'workflow',
];

const SCOPE_LABELS: Record<string, string> = {
  audience: 'audience',
  channel: 'channel',
  domain: 'domain',
  personEmail: 'person',
  projectId: 'project',
};

interface LearningResponse {
  preferences: LearnedPreference[];
  enabled: boolean;
  actionableConfidence: number;
}

function OriginBadge({ pref }: { pref: LearnedPreference }) {
  if (pref.origin === 'explicit') return <Badge tone="green">you told Jarvis</Badge>;
  if (pref.origin === 'feedback') return <Badge tone="amber">from your feedback</Badge>;
  return <Badge tone="blue">inferred from behavior</Badge>;
}

function StatusBadge({ pref, actionable }: { pref: LearnedPreference; actionable: number }) {
  if (pref.status === 'rejected') return <Badge tone="red">marked wrong</Badge>;
  if (pref.status === 'retired') return <Badge tone="neutral">faded out</Badge>;
  if (pref.confidence < actionable && pref.pinned !== 1 && pref.origin !== 'explicit') {
    return <Badge tone="neutral">tentative — not used yet</Badge>;
  }
  return null;
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-1.5" title={`Confidence ${pct}%`}>
      <span className="h-1.5 w-16 rounded-full bg-surface-sunken overflow-hidden">
        <span
          className={clsx(
            'block h-full rounded-full',
            pct >= 70 ? 'bg-emerald-500' : pct >= 45 ? 'bg-amber-500' : 'bg-surface-border',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-xs text-ink-faint">{pct}%</span>
    </span>
  );
}

function ScopeChips({ pref }: { pref: LearnedPreference }) {
  const entries = Object.entries(pref.scope ?? {}).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([k, v]) => (
        <span key={k} className="text-xs text-ink-faint">
          {SCOPE_LABELS[k] ?? k}: {String(v)}
        </span>
      ))}
    </>
  );
}

/** Lazy-loaded "why Jarvis thinks this" panel with the evidence trail. */
function ExplainPanel({ preferenceId }: { preferenceId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['learning', 'explain', preferenceId],
    queryFn: () =>
      api.get<{ preference: LearnedPreference; recentSignals: LearningSignal[] }>(
        `/api/learning/preferences/${preferenceId}/explain`,
      ),
  });
  if (isLoading) return <p className="text-xs text-ink-faint mt-2">Loading evidence…</p>;
  if (!data) return null;
  const { preference, recentSignals } = data;
  return (
    <div className="mt-2 rounded-lg bg-surface-sunken p-3 space-y-2">
      <p className="text-xs text-ink-muted">{preference.explanation}</p>
      {recentSignals.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink mb-1">
            Evidence ({preference.evidenceCount} observation
            {preference.evidenceCount === 1 ? '' : 's'}
            {preference.contradictionCount > 0 &&
              `, ${preference.contradictionCount} pointing the other way`}
            ):
          </div>
          <ul className="space-y-0.5">
            {recentSignals.slice(0, 6).map((s) => (
              <li key={s.id} className="text-xs text-ink-faint">
                • {s.detail ?? `${s.kind} signal`} — {timeAgo(s.observedAt)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preference.userNote && (
        <p className="text-xs text-ink-faint">Your note: {preference.userNote}</p>
      )}
    </div>
  );
}

export function LearningPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['learning'],
    queryFn: () => api.get<LearningResponse>('/api/learning'),
  });
  const { data: contradictionsData } = useQuery({
    queryKey: ['learning', 'contradictions'],
    queryFn: () =>
      api.get<{ contradictions: ContradictionReportEntry[] }>('/api/learning/contradictions'),
  });
  const enabled = data?.enabled ?? true;
  const actionable = data?.actionableConfidence ?? 0.45;
  const preferences = data?.preferences ?? [];
  const contradictions = contradictionsData?.contradictions ?? [];

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newStatement, setNewStatement] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['learning'] });
  };
  const onError = (e: unknown) =>
    setError(e instanceof Error ? e.message : 'Something went wrong.');

  const setEnabled = useMutation({
    mutationFn: (value: boolean) =>
      api.put<{ enabled: boolean }>('/api/learning/settings', { enabled: value }),
    onSuccess: invalidate,
    onError,
  });
  const learnNow = useMutation({
    mutationFn: () => api.post<{ signals: number }>('/api/learning/run'),
    onSuccess: invalidate,
    onError,
  });
  const add = useMutation({
    mutationFn: () =>
      api.post<{ preference: LearnedPreference }>('/api/learning/preferences', {
        statement: newStatement.trim(),
      }),
    onSuccess: () => {
      setNewStatement('');
      setError(null);
      invalidate();
    },
    onError,
  });
  const correct = useMutation({
    mutationFn: ({ id, action, statement }: { id: string; action: string; statement?: string }) =>
      api.post<{ preference: LearnedPreference | null }>(
        `/api/learning/preferences/${id}/correct`,
        statement !== undefined ? { action, statement } : { action },
      ),
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      invalidate();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/learning/preferences/${id}`),
    onSuccess: invalidate,
    onError,
  });

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    prefs: preferences.filter((p) => p.category === category),
  })).filter((g) => g.prefs.length > 0);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <PageHeader
        title="Learned Preferences"
        subtitle="What Jarvis has learned about how you work — with the evidence, so you can correct it anytime."
        actions={
          <Button onClick={() => learnNow.mutate()} loading={learnNow.isPending} disabled={!enabled}>
            <RefreshCw className="h-4 w-4" /> Learn now
          </Button>
        }
      />

      {isLoading ? (
        <LoadingPane />
      ) : (
        <>
          <Card className="p-4 mb-6 flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-ink">Self-learning</div>
              <p className="text-sm text-ink-muted mt-0.5">
                When off, Jarvis stops learning from your email, chats, calendar, and feedback.
                Existing preferences stay visible here but are not applied.
              </p>
            </div>
            <Switch checked={enabled} onChange={(v) => setEnabled.mutate(v)} />
          </Card>

          {error && (
            <p role="alert" className="text-sm text-red-600 mb-4">
              {error}
            </p>
          )}

          {contradictions.length > 0 && (
            <Card className="p-4 mb-6 bg-amber-50 border-amber-200">
              <div className="text-sm font-medium text-ink mb-1">Mixed signals</div>
              <ul className="space-y-1">
                {contradictions.map((c, i) => (
                  <li key={i} className="text-xs text-ink-muted">
                    {c.description}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className={clsx(!enabled && 'opacity-50')}>
            <form
              className="flex items-center gap-2 mb-6"
              onSubmit={(e) => {
                e.preventDefault();
                if (newStatement.trim()) add.mutate();
              }}
            >
              <Input
                placeholder="Tell Jarvis a preference, e.g. “keep summaries short” or “jane@acme.com is high priority”…"
                value={newStatement}
                onChange={(e) => setNewStatement(e.target.value)}
                className="flex-1"
              />
              <Button type="submit" variant="primary" loading={add.isPending}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </form>

            {groups.length === 0 ? (
              <EmptyState
                icon={<GraduationCap />}
                title="Nothing learned yet"
                description="As you work — replying, giving feedback, editing drafts — Jarvis learns what matters to you and shows it here, with the evidence."
              />
            ) : (
              <div className="space-y-6">
                {groups.map(({ category, prefs }) => (
                  <section key={category}>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge tone="accent">{CATEGORY_LABELS[category]}</Badge>
                      <span className="text-xs text-ink-faint">{prefs.length}</span>
                    </div>
                    <Card className="divide-y divide-surface-border">
                      {prefs.map((p) => (
                        <div key={p.id} className="px-4 py-3">
                          <div className="flex items-start gap-3">
                            <button
                              type="button"
                              title="Show why Jarvis thinks this"
                              className="mt-0.5 text-ink-faint hover:text-ink"
                              onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                            >
                              {expandedId === p.id ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                            <div className="flex-1 min-w-0">
                              {editingId === p.id ? (
                                <div className="space-y-2">
                                  <Textarea
                                    rows={2}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    autoFocus
                                  />
                                  <div className="flex gap-2">
                                    <Button
                                      size="sm"
                                      variant="primary"
                                      loading={correct.isPending}
                                      onClick={() =>
                                        correct.mutate({
                                          id: p.id,
                                          action: 'edit',
                                          statement: draft.trim(),
                                        })
                                      }
                                    >
                                      Save
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  title="Click to edit"
                                  className={clsx(
                                    'text-left text-sm transition-colors hover:text-jarvis-700',
                                    p.status === 'active' ? 'text-ink' : 'text-ink-faint line-through',
                                  )}
                                  onClick={() => {
                                    setEditingId(p.id);
                                    setDraft(p.statement);
                                  }}
                                >
                                  {p.statement}
                                </button>
                              )}
                              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                <OriginBadge pref={p} />
                                <StatusBadge pref={p} actionable={actionable} />
                                {p.pinned === 1 && <Badge tone="accent">pinned</Badge>}
                                <ConfidenceBar value={p.confidence} />
                                <ScopeChips pref={p} />
                                <span className="text-xs text-ink-faint">
                                  updated {timeAgo(p.updatedAt)}
                                </span>
                              </div>
                              {expandedId === p.id && <ExplainPanel preferenceId={p.id} />}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {p.origin !== 'explicit' && p.status === 'active' && (
                                <button
                                  type="button"
                                  title="Confirm — yes, this is right"
                                  className="text-ink-faint hover:text-emerald-600"
                                  onClick={() => correct.mutate({ id: p.id, action: 'confirm' })}
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                title={p.pinned === 1 ? 'Unpin' : 'Pin — never fade this out'}
                                className="text-ink-faint hover:text-jarvis-700"
                                onClick={() =>
                                  correct.mutate({ id: p.id, action: p.pinned === 1 ? 'unpin' : 'pin' })
                                }
                              >
                                {p.pinned === 1 ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                              </button>
                              {p.status === 'active' && (
                                <button
                                  type="button"
                                  title="Mark wrong — Jarvis stops using this and won't re-learn it"
                                  className="text-ink-faint hover:text-amber-600"
                                  onClick={() => correct.mutate({ id: p.id, action: 'mark_wrong' })}
                                >
                                  <ThumbsDown className="h-4 w-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                title="Delete — forget this and its evidence"
                                className="text-ink-faint hover:text-red-600"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      'Delete this preference? Jarvis forgets it and the evidence behind it.',
                                    )
                                  ) {
                                    remove.mutate(p.id);
                                  }
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </Card>
                  </section>
                ))}
              </div>
            )}
          </div>

          <p className="text-center text-xs text-ink-faint mt-10">
            Jarvis learns tendencies, never labels — and only from repeated behavior or what you say
            directly. Sensitive topics are never learned.
          </p>
        </>
      )}
    </div>
  );
}
