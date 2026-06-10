import type { FeedbackKind, TaskCandidate } from '@donna/core';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Flame,
  Snowflake,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { SignalsList } from '../../components/domain.js';
import { Badge, Card, LevelPill } from '../../components/ui.js';
import { smartTime } from '../../lib/format.js';

const FEEDBACK_ACTIONS: { kind: FeedbackKind; label: string; icon: ReactNode }[] = [
  { kind: 'important', label: 'Important', icon: <ArrowUp className="h-4 w-4" /> },
  { kind: 'not_important', label: 'Not important', icon: <ArrowDown className="h-4 w-4" /> },
  { kind: 'urgent', label: 'Urgent', icon: <Flame className="h-4 w-4" /> },
  { kind: 'not_urgent', label: 'Not urgent', icon: <Snowflake className="h-4 w-4" /> },
  { kind: 'incorrect', label: 'Incorrect', icon: <ThumbsDown className="h-4 w-4" /> },
  { kind: 'more_like_this', label: 'More like this', icon: <ThumbsUp className="h-4 w-4" /> },
];

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-ink-faint hover:text-ink hover:bg-surface-sunken transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

export function TaskCard({
  task,
  onOpenSource,
  onSetStatus,
  onFeedback,
}: {
  task: TaskCandidate;
  onOpenSource: (sourceItemId: string) => void;
  /** PATCH /api/tasks/:id — done removes the card optimistically. */
  onSetStatus: (id: string, status: 'done' | 'deferred') => void;
  /** POST /api/feedback — resolves when recorded. */
  onFeedback: (id: string, kind: FeedbackKind) => Promise<unknown>;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const [thanked, setThanked] = useState(false);
  const [sending, setSending] = useState(false);
  const sourceItemId = task.sourceItemId;

  const sendFeedback = (kind: FeedbackKind) => {
    setSending(true);
    onFeedback(task.id, kind)
      .then(() => setThanked(true))
      .catch(() => {})
      .finally(() => setSending(false));
  };

  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
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

      <div className="flex items-center gap-0.5 mt-3 pt-2 border-t border-surface-border/70">
        <IconAction label="Done" onClick={() => onSetStatus(task.id, 'done')}>
          <Check className="h-4 w-4" />
        </IconAction>
        <IconAction label="Defer" onClick={() => onSetStatus(task.id, 'deferred')}>
          <Clock className="h-4 w-4" />
        </IconAction>
        <span className="mx-1 h-4 w-px bg-surface-border" aria-hidden />
        {FEEDBACK_ACTIONS.map((a) => (
          <IconAction
            key={a.kind}
            label={a.label}
            disabled={sending}
            onClick={() => sendFeedback(a.kind)}
          >
            {a.icon}
          </IconAction>
        ))}
        {thanked && (
          <span className="ml-auto text-xs text-emerald-700 pr-1">Thanks — noted.</span>
        )}
      </div>
    </Card>
  );
}
