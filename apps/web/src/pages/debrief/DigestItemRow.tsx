import type { DigestItem, FeedbackKind } from '@donna/core';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { SignalsList, SourceCategoryIcon } from '../../components/domain.js';
import { QuickActionBar } from '../../components/quick-actions.js';
import { Card, CategoryBadge, LevelPill } from '../../components/ui.js';
import { smartTime } from '../../lib/format.js';

/**
 * One ranked debrief item: title (opens the underlying source when available),
 * provenance line, the priority/urgency/effort trio, recommended action,
 * explanation, a "Why this matters" disclosure with scoring signals, and the
 * same quick-action row as Priorities cards. Done/Defer act on the linked
 * task candidate, so they're disabled when the item doesn't have one.
 */
export function DigestItemRow({
  item,
  selected,
  onToggleSelect,
  onOpenSource,
  onSetStatus,
  onFeedback,
}: {
  item: DigestItem;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpenSource: (sourceItemId: string) => void;
  /** PATCH /api/tasks/:taskCandidateId — resolves when recorded. */
  onSetStatus: (item: DigestItem, status: 'done' | 'deferred') => Promise<unknown>;
  /** POST /api/feedback — resolves when recorded. */
  onFeedback: (item: DigestItem, kind: FeedbackKind) => Promise<unknown>;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const sourceItemId = item.sourceItemId;

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <input
          type="checkbox"
          className="mt-1 h-3.5 w-3.5 shrink-0 accent-donna-600"
          checked={selected}
          onChange={() => onToggleSelect(item.id)}
          aria-label={`Select "${item.title}"`}
        />
        <div className="min-w-0 flex-1">
          {sourceItemId ? (
            <button
              type="button"
              onClick={() => onOpenSource(sourceItemId)}
              className="text-left text-[15px] font-medium leading-snug text-ink hover:text-donna-700 transition-colors"
            >
              {item.title}
            </button>
          ) : (
            <div className="text-[15px] font-medium leading-snug">{item.title}</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-muted">
            <SourceCategoryIcon category={item.sourceCategory} className="h-3.5 w-3.5 text-ink-faint" />
            <span>{item.sourceLabel}</span>
            {item.itemTimestamp && (
              <>
                <span className="text-ink-faint">·</span>
                <span>{smartTime(item.itemTimestamp)}</span>
              </>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <CategoryBadge category={item.planningCategory} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <LevelPill level={item.priorityLevel} label="priority" />
        <LevelPill level={item.urgencyLevel} label="urgency" />
        <LevelPill level={item.effortLevel} label="effort" />
      </div>

      {item.recommendedAction && (
        <p className="mt-3 text-sm font-medium text-donna-700">→ {item.recommendedAction}</p>
      )}
      {item.explanation && (
        <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{item.explanation}</p>
      )}

      <button
        type="button"
        onClick={() => setShowWhy((v) => !v)}
        aria-expanded={showWhy}
        className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-faint hover:text-ink transition-colors"
      >
        <ChevronRight className={clsx('h-3.5 w-3.5 transition-transform', showWhy && 'rotate-90')} />
        Why this matters
      </button>
      {showWhy && (
        <div className="mt-2.5 rounded-lg bg-surface-sunken px-3.5 py-3">
          <SignalsList signals={item.signals} />
        </div>
      )}

      <QuickActionBar
        statusDisabled={item.taskCandidateId === null}
        onSetStatus={(status) => onSetStatus(item, status)}
        onFeedback={(kind) => onFeedback(item, kind)}
      />
    </Card>
  );
}
