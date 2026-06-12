import type { FeedbackKind, TaskCandidate } from '@donna/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { SignalsList } from '../../components/domain.js';
import { QuickActionBar } from '../../components/quick-actions.js';
import { Badge, Card, LevelPill } from '../../components/ui.js';
import { smartTime } from '../../lib/format.js';

export function TaskCard({
  task,
  selected,
  onToggleSelect,
  onOpenSource,
  onSetStatus,
  onFeedback,
}: {
  task: TaskCandidate;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpenSource: (sourceItemId: string) => void;
  /** PATCH /api/tasks/:id — done removes the card optimistically. */
  onSetStatus: (id: string, status: 'done' | 'deferred') => void;
  /** POST /api/feedback — resolves when recorded. */
  onFeedback: (id: string, kind: FeedbackKind) => Promise<unknown>;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const sourceItemId = task.sourceItemId;

  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <input
          type="checkbox"
          className="mt-1 h-3.5 w-3.5 shrink-0 accent-donna-600"
          checked={selected}
          onChange={() => onToggleSelect(task.id)}
          aria-label={`Select "${task.title}"`}
        />
        <div className="min-w-0 flex-1">
          {sourceItemId ? (
            <button
              type="button"
              onClick={() => onOpenSource(sourceItemId)}
              className="text-left font-medium text-[15px] leading-snug hover:text-donna-700 transition-colors"
            >
              {task.title}
            </button>
          ) : (
            <div className="font-medium text-[15px] leading-snug">{task.title}</div>
          )}
          {task.explanation && (
            <p className="text-sm text-ink-muted mt-1 leading-relaxed">{task.explanation}</p>
          )}
          {task.recommendedAction && (
            <p className="text-sm text-donna-700 mt-1.5">→ {task.recommendedAction}</p>
          )}
        </div>
        <span
          className="text-xs text-ink-faint tabular-nums shrink-0 mt-0.5"
          title="Overall priority score"
        >
          {Math.round(task.overallScore)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
        <LevelPill level={task.priorityLevel} label="priority" />
        <LevelPill level={task.urgencyLevel} label="urgency" />
        <LevelPill level={task.effortLevel} label="effort" />
        {task.dueAt && <Badge tone="amber">due {smartTime(task.dueAt)}</Badge>}
        <button
          type="button"
          onClick={() => setWhyOpen((v) => !v)}
          aria-expanded={whyOpen}
          className="inline-flex items-center gap-0.5 text-xs text-ink-muted hover:text-ink ml-1 transition-colors"
        >
          {whyOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Why?
        </button>
      </div>

      {whyOpen && (
        <div className="mt-3 border-t border-surface-border/70 pt-3">
          <SignalsList signals={task.signals} />
        </div>
      )}

      <QuickActionBar
        onSetStatus={(status) => onSetStatus(task.id, status)}
        onFeedback={(kind) => onFeedback(task.id, kind)}
      />
    </Card>
  );
}
