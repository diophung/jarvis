import type { DigestItem, FeedbackKind, TaskCandidate } from '@donna/core';
import { DIGEST_SECTION_LABELS, DIGEST_SECTIONS } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Cpu, History, RefreshCw, Sparkles, Sun } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SourceItemModal } from '../components/domain.js';
import type { BulkApplyResult, QuickAction } from '../components/quick-actions.js';
import { applyToEach, BulkActionBar, useSelection } from '../components/quick-actions.js';
import { Badge, Button, Card, EmptyState, LoadingPane, Markdown } from '../components/ui.js';
import { api } from '../lib/api.js';
import { fullDate, timeAgo } from '../lib/format.js';
import { DigestItemRow } from './debrief/DigestItemRow.js';
import type { DigestWithItems } from './debrief/types.js';

/**
 * The Daily Debrief — an executive briefing, not a dashboard.
 * `/debrief` shows the latest digest; `/digests/:digestId` shows a past one.
 */
export function DebriefPage() {
  const { digestId } = useParams<{ digestId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [openSourceItemId, setOpenSourceItemId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['digest', digestId ?? 'latest'],
    queryFn: () =>
      api.get<{ digest: DigestWithItems | null }>(
        digestId ? `/api/digests/${digestId}` : '/api/digests/latest',
      ),
  });

  const generate = useMutation({
    mutationFn: (supersedesDigestId: string | null) =>
      api.post<{ digest: DigestWithItems }>('/api/digests/generate', {
        kind: 'manual',
        ...(supersedesDigestId ? { supersedesDigestId } : {}),
      }),
    onSuccess: (res) => {
      qc.setQueryData(['digest', 'latest'], { digest: res.digest });
      qc.invalidateQueries({ queryKey: ['digest'] });
      qc.invalidateQueries({ queryKey: ['digests'] });
      if (digestId) navigate('/debrief');
    },
  });

  const digest = data?.digest ?? null;

  const sections = useMemo(() => {
    if (!digest) return [];
    return DIGEST_SECTIONS.map((section) => ({
      section,
      items: digest.items
        .filter((item) => item.section === section)
        .sort((a, b) => a.rank - b.rank),
    })).filter((s) => s.items.length > 0);
  }, [digest]);

  const visibleItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const itemIds = useMemo(() => visibleItems.map((i) => i.id), [visibleItems]);
  const { selected, toggle, selectAll, deselectAll } = useSelection(itemIds);

  // Done/Defer act on the task candidate behind the digest item — the same
  // endpoint the Priorities page uses — so the two pages stay in sync.
  const setTaskStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'done' | 'deferred' }) =>
      api.patch<{ task: TaskCandidate }>(`/api/tasks/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const feedback = useMutation({
    mutationFn: (input: {
      kind: FeedbackKind;
      digestItemId: string;
      taskCandidateId?: string;
      sourceItemId?: string;
    }) => api.post<{ ok: true }>('/api/feedback', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const feedbackPayload = (item: DigestItem, kind: FeedbackKind) => ({
    kind,
    digestItemId: item.id,
    ...(item.taskCandidateId !== null ? { taskCandidateId: item.taskCandidateId } : {}),
    ...(item.sourceItemId !== null ? { sourceItemId: item.sourceItemId } : {}),
  });

  const bulkApply = async (
    action: QuickAction,
    scope: 'selected' | 'all',
  ): Promise<BulkApplyResult> => {
    const chosen = scope === 'all' ? visibleItems : visibleItems.filter((i) => selected.has(i.id));
    if (action.type === 'status') {
      const withTask = chosen.filter((i) => i.taskCandidateId !== null);
      const { ok, failed } = await applyToEach(withTask, (i) =>
        api.patch<{ task: TaskCandidate }>(`/api/tasks/${i.taskCandidateId}`, {
          status: action.status,
        }),
      );
      qc.invalidateQueries({ queryKey: ['tasks'] });
      const skipped = chosen.length - withTask.length;
      return {
        applied: ok,
        ...(skipped > 0 ? { skipped } : {}),
        ...(failed > 0 ? { failed } : {}),
      };
    }
    const { ok, failed } = await applyToEach(chosen, (i) =>
      api.post<{ ok: true }>('/api/feedback', feedbackPayload(i, action.kind)),
    );
    qc.invalidateQueries({ queryKey: ['tasks'] });
    return { applied: ok, ...(failed > 0 ? { failed } : {}) };
  };

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <LoadingPane label="Loading your debrief…" />
      </div>
    );
  }

  if (isError || (digestId && !digest)) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <EmptyState
          icon={<AlertTriangle />}
          title="Couldn't load this debrief"
          description="It may have been removed, or something went wrong while fetching it."
          action={
            <Link to="/debrief" className="text-sm font-medium text-donna-700 hover:underline">
              Back to the latest debrief
            </Link>
          }
        />
      </div>
    );
  }

  if (!digest) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <EmptyState
          icon={<Sun />}
          title="No debrief yet"
          description="Donna hasn't prepared a briefing for you yet. Generate one now — she'll look across everything from your connected sources and pull out what actually matters. This can take a few seconds."
          action={
            <Button
              variant="primary"
              loading={generate.isPending}
              onClick={() => generate.mutate(null)}
            >
              {!generate.isPending && <Sparkles className="h-4 w-4" />}
              {generate.isPending ? 'Generating…' : 'Generate my debrief'}
            </Button>
          }
        />
      </div>
    );
  }

  const considered = digest.stats['totalConsidered'] ?? 0;
  const ignored = digest.stats['ignored'] ?? 0;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {digestId && (
        <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-surface-border bg-surface-sunken px-3.5 py-2.5 text-[13px] text-ink-muted">
          <History className="h-3.5 w-3.5 shrink-0" />
          <span>You're viewing a past debrief — generated {timeAgo(digest.generatedAt)}.</span>
          <Link to="/debrief" className="font-medium text-donna-700 hover:underline">
            Back to the latest
          </Link>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Daily Debrief</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <span>{fullDate(digest.generatedAt)}</span>
            <Badge tone="accent">{digest.kind}</Badge>
            <Badge tone="neutral">
              <Cpu className="h-3 w-3" />
              {digest.modelUsed ?? 'rule-based'}
            </Badge>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="flex items-center justify-end gap-1.5">
            {!digestId && (
              <Link
                to="/digests"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink transition-colors"
              >
                <History className="h-3.5 w-3.5" /> View history
              </Link>
            )}
            <Button
              variant="secondary"
              size="sm"
              loading={generate.isPending}
              onClick={() => generate.mutate(digest.id)}
            >
              {!generate.isPending && <RefreshCw className="h-3.5 w-3.5" />}
              Regenerate
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-faint">Previous versions are kept</p>
        </div>
      </div>

      {digest.status === 'error' && (
        <Card className="mt-6 border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This debrief failed to generate{digest.error ? `: ${digest.error}` : '.'} Try
              regenerating it.
            </span>
          </div>
        </Card>
      )}

      {digest.summaryMarkdown && (
        <Card className="mt-6 p-6 sm:p-8">
          <Markdown>{digest.summaryMarkdown}</Markdown>
        </Card>
      )}

      <div className="mt-8">
        {visibleItems.length > 0 && (
          <BulkActionBar
            total={visibleItems.length}
            selectedCount={selected.size}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onApply={bulkApply}
          />
        )}
        <div className="space-y-8">
          {sections.map(({ section, items }) => (
            <section key={section}>
              <div className="mb-3 flex items-baseline gap-2">
                <h2 className="text-[15px] font-semibold">{DIGEST_SECTION_LABELS[section]}</h2>
                <span className="text-[12px] tabular-nums text-ink-faint">{items.length}</span>
              </div>
              <div className="space-y-3">
                {items.map((item) => (
                  <DigestItemRow
                    key={item.id}
                    item={item}
                    selected={selected.has(item.id)}
                    onToggleSelect={toggle}
                    onOpenSource={setOpenSourceItemId}
                    onSetStatus={(it, status) =>
                      it.taskCandidateId !== null
                        ? setTaskStatus.mutateAsync({ id: it.taskCandidateId, status })
                        : Promise.resolve()
                    }
                    onFeedback={(it, kind) => feedback.mutateAsync(feedbackPayload(it, kind))}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {digest.planMarkdown && (
        <Card className="mt-8 p-6 sm:p-8">
          <h2 className="mb-3 text-[15px] font-semibold">Suggested plan for today</h2>
          <Markdown>{digest.planMarkdown}</Markdown>
        </Card>
      )}

      <p className="mt-8 pb-4 text-center text-[12.5px] text-ink-faint">
        {`Considered ${considered} items · ignored ${ignored} low-signal items`}
      </p>

      <SourceItemModal itemId={openSourceItemId} onClose={() => setOpenSourceItemId(null)} />
    </div>
  );
}
