import type {
  FeedbackKind,
  PlanningCategory,
  TaskCandidate,
  TaskCandidateStatus,
} from '@jarvis/core';
import { PLANNING_CATEGORY_LABELS } from '@jarvis/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ListTodo, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SourceItemModal } from '../components/domain.js';
import type { BulkApplyResult, QuickAction } from '../components/quick-actions.js';
import { applyToEach, BulkActionBar, useSelection } from '../components/quick-actions.js';
import { Button, EmptyState, LoadingPane, PageHeader, Select } from '../components/ui.js';
import { api } from '../lib/api.js';
import { TaskCard } from './tasks/TaskCard.js';

/** Display order for planning groups — most actionable first. */
const CATEGORY_ORDER: PlanningCategory[] = [
  'do_now',
  'prepare_today',
  'decide',
  'waiting_on_others',
  'follow_up',
  'read_when_possible',
  'low_priority',
];

const STATUS_FILTERS: { value: TaskCandidateStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'dismissed', label: 'Dismissed' },
];

const EMPTY_COPY: Record<TaskCandidateStatus, { title: string; description: string }> = {
  open: {
    title: 'Nothing open — enjoy the calm.',
    description: 'New priorities appear here as Jarvis scores your connected sources.',
  },
  done: {
    title: 'Nothing marked done yet.',
    description: 'Items you complete will show up here.',
  },
  deferred: {
    title: 'Nothing deferred.',
    description: 'Items you push to later will wait here.',
  },
  dismissed: {
    title: 'Nothing dismissed.',
    description: 'Items you dismiss will show up here.',
  },
};

export function TasksPage() {
  const [status, setStatus] = useState<TaskCandidateStatus>('open');
  const [category, setCategory] = useState<'all' | PlanningCategory>('all');
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['tasks', status, category],
    queryFn: () =>
      api.get<{ items: TaskCandidate[] }>(
        `/api/tasks?status=${status}${category === 'all' ? '' : `&category=${category}`}`,
      ),
  });

  const rescore = useMutation({
    mutationFn: () => api.post<{ scored: number }>('/api/tasks/rescore'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const setTaskStatus = useMutation({
    mutationFn: ({ id, status: next }: { id: string; status: 'done' | 'deferred' }) =>
      api.patch<{ task: TaskCandidate }>(`/api/tasks/${id}`, { status: next }),
    onMutate: async ({ id, status: next }) => {
      // Optimistically remove from the visible list when marking done.
      if (next === 'done') {
        await qc.cancelQueries({ queryKey: ['tasks'] });
        qc.setQueriesData<{ items: TaskCandidate[] }>({ queryKey: ['tasks'] }, (old) =>
          old ? { items: old.items.filter((t) => t.id !== id) } : old,
        );
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const feedback = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: FeedbackKind }) =>
      api.post<{ ok: true }>('/api/feedback', { kind, taskCandidateId: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        category: cat,
        tasks: items.filter((t) => t.planningCategory === cat),
      })).filter((g) => g.tasks.length > 0),
    [items],
  );

  const itemIds = useMemo(() => items.map((t) => t.id), [items]);
  const { selected, toggle, selectAll, deselectAll } = useSelection(itemIds);

  const bulkApply = async (
    action: QuickAction,
    scope: 'selected' | 'all',
  ): Promise<BulkApplyResult> => {
    const targets = scope === 'all' ? items : items.filter((t) => selected.has(t.id));
    const { ok, failed } = await applyToEach(targets, (t) =>
      action.type === 'status'
        ? api.patch<{ task: TaskCandidate }>(`/api/tasks/${t.id}`, { status: action.status })
        : api.post<{ ok: true }>('/api/feedback', { kind: action.kind, taskCandidateId: t.id }),
    );
    qc.invalidateQueries({ queryKey: ['tasks'] });
    return { applied: ok, ...(failed > 0 ? { failed } : {}) };
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <PageHeader
        title="Priorities"
        subtitle="Scored from your connected sources — tell Jarvis when it gets one wrong."
        actions={
          <Button
            variant="secondary"
            loading={rescore.isPending}
            onClick={() => rescore.mutate()}
          >
            {!rescore.isPending && <RefreshCw className="h-3.5 w-3.5" />}
            Rescore
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-6">
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatus(f.value)}
              className={clsx(
                'rounded-full px-3 py-1 text-[13px] border transition-colors',
                status === f.value
                  ? 'bg-jarvis-100 border-jarvis-200 text-jarvis-900 font-medium'
                  : 'border-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <Select
            value={category}
            onChange={(v) => setCategory(v as 'all' | PlanningCategory)}
            options={[
              { value: 'all', label: 'All categories' },
              ...CATEGORY_ORDER.map((c) => ({ value: c, label: PLANNING_CATEGORY_LABELS[c] })),
            ]}
          />
        </div>
      </div>

      {isLoading && <LoadingPane label="Loading priorities…" />}

      {!isLoading && items.length > 0 && (
        <BulkActionBar
          total={items.length}
          selectedCount={selected.size}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onApply={bulkApply}
        />
      )}

      {!isLoading && items.length === 0 && (
        <EmptyState
          icon={<ListTodo />}
          title={EMPTY_COPY[status].title}
          description={EMPTY_COPY[status].description}
        />
      )}

      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.category}>
            <h2 className="text-sm font-semibold text-ink mb-3">
              {PLANNING_CATEGORY_LABELS[group.category]}{' '}
              <span className="text-ink-faint font-normal">· {group.tasks.length}</span>
            </h2>
            <div className="space-y-3">
              {group.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={selected.has(task.id)}
                  onToggleSelect={toggle}
                  onOpenSource={setOpenItemId}
                  onSetStatus={(id, next) => setTaskStatus.mutate({ id, status: next })}
                  onFeedback={(id, kind) => feedback.mutateAsync({ id, kind })}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <SourceItemModal itemId={openItemId} onClose={() => setOpenItemId(null)} />
    </div>
  );
}
