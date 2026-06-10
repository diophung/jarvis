import type { MemoryEntry, MemoryKind } from '@donna/core';
import { MEMORY_KINDS } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Brain, Download, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingPane,
  PageHeader,
  Select,
  Switch,
  Textarea,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/format.js';

const KIND_GROUP_LABELS: Record<MemoryKind, string> = {
  preference: 'Preferences',
  fact: 'Facts',
  person: 'People',
  project: 'Projects',
  behavior: 'Behaviors',
  instruction: 'Instructions',
};

const KIND_LABELS: Record<MemoryKind, string> = {
  preference: 'Preference',
  fact: 'Fact',
  person: 'Person',
  project: 'Project',
  behavior: 'Behavior',
  instruction: 'Instruction',
};

/** Where a memory came from, in plain language. */
function OriginChip({ entry }: { entry: MemoryEntry }) {
  if (entry.origin === 'inferred') {
    return <Badge tone="blue">inferred · {Math.round(entry.confidence * 100)}% sure</Badge>;
  }
  if (entry.origin === 'feedback') {
    return <Badge tone="amber">from your feedback</Badge>;
  }
  return <Badge tone="green">you told Donna</Badge>;
}

export function MemoryPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['memory'],
    queryFn: () => api.get<{ items: MemoryEntry[]; enabled: boolean }>('/api/memory'),
  });
  const enabled = data?.enabled ?? true;
  const items = data?.items ?? [];

  const [newKind, setNewKind] = useState<string>('preference');
  const [newContent, setNewContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['memory'] });

  const setEnabled = useMutation({
    mutationFn: (value: boolean) =>
      api.put<{ enabled: boolean }>('/api/memory/settings', { enabled: value }),
    onSuccess: invalidate,
  });
  const add = useMutation({
    mutationFn: () =>
      api.post<{ memory: MemoryEntry }>('/api/memory', {
        kind: newKind,
        content: newContent.trim(),
      }),
    onSuccess: () => {
      setNewContent('');
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch<{ memory: MemoryEntry }>(`/api/memory/${id}`, patch),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/memory/${id}`),
    onSuccess: invalidate,
  });

  const onExport = async () => {
    const exported = await api.get<{ items: MemoryEntry[] }>('/api/memory/export');
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'donna-memory.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const groups = MEMORY_KINDS.map((kind) => ({
    kind,
    entries: items.filter((m) => m.kind === kind),
  })).filter((g) => g.entries.length > 0);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <PageHeader
        title="Memory"
        subtitle="What Donna believes about you — always visible, always editable."
        actions={
          <Button onClick={() => void onExport()}>
            <Download className="h-4 w-4" /> Export memory
          </Button>
        }
      />

      {isLoading ? (
        <LoadingPane />
      ) : (
        <>
          <Card className="p-4 mb-6 flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-ink">Memory</div>
              <p className="text-sm text-ink-muted mt-0.5">
                When off, Donna stores and uses nothing new about you.
              </p>
            </div>
            <Switch checked={enabled} onChange={(v) => setEnabled.mutate(v)} />
          </Card>

          <div className={clsx(!enabled && 'opacity-50')}>
            <form
              className="flex items-center gap-2 mb-6"
              onSubmit={(e) => {
                e.preventDefault();
                if (newContent.trim()) add.mutate();
              }}
            >
              <Select
                value={newKind}
                onChange={setNewKind}
                options={MEMORY_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
              />
              <Input
                placeholder="Tell Donna something to remember…"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                className="flex-1"
              />
              <Button type="submit" variant="primary" loading={add.isPending}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </form>

            {groups.length === 0 ? (
              <EmptyState
                icon={<Brain />}
                title="Nothing saved yet"
                description="Add something above, or let Donna save useful preferences and facts as you work together."
              />
            ) : (
              <div className="space-y-6">
                {groups.map(({ kind, entries }) => (
                  <section key={kind}>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge tone="accent">{KIND_GROUP_LABELS[kind]}</Badge>
                      <span className="text-xs text-ink-faint">{entries.length}</span>
                    </div>
                    <Card className="divide-y divide-surface-border">
                      {entries.map((m) => (
                        <div key={m.id} className="px-4 py-3 flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            {editingId === m.id ? (
                              <div className="space-y-2">
                                <Textarea
                                  rows={3}
                                  value={draft}
                                  onChange={(e) => setDraft(e.target.value)}
                                  autoFocus
                                />
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    loading={update.isPending}
                                    onClick={() =>
                                      update.mutate({
                                        id: m.id,
                                        patch: { content: draft.trim() },
                                      })
                                    }
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setEditingId(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                title="Click to edit"
                                className="text-left text-sm text-ink hover:text-donna-700 transition-colors"
                                onClick={() => {
                                  setEditingId(m.id);
                                  setDraft(m.content);
                                }}
                              >
                                {m.content}
                              </button>
                            )}
                            <div className="flex flex-wrap items-center gap-2 mt-1.5">
                              <OriginChip entry={m} />
                              {m.lastUsedAt && (
                                <span className="text-xs text-ink-faint">
                                  used {timeAgo(m.lastUsedAt)}
                                </span>
                              )}
                            </div>
                          </div>
                          <Switch
                            checked={m.enabled === 1}
                            onChange={(v) =>
                              update.mutate({ id: m.id, patch: { enabled: v ? 1 : 0 } })
                            }
                          />
                          <button
                            type="button"
                            title="Delete memory"
                            className="text-ink-faint hover:text-red-600 mt-0.5"
                            onClick={() => {
                              if (window.confirm('Delete this memory? Donna will forget it.')) {
                                remove.mutate(m.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                    </Card>
                  </section>
                ))}
              </div>
            )}
          </div>

          <p className="text-center text-xs text-ink-faint mt-10">
            Donna shows you exactly what it believes. Correct or delete anything.
          </p>
        </>
      )}
    </div>
  );
}
