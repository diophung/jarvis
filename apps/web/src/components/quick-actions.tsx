import type { FeedbackKind } from '@jarvis/core';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  Flame,
  Snowflake,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Button, Select } from './ui.js';

/** A status change (PATCH /api/tasks/:id) or a feedback signal (POST /api/feedback). */
export type QuickAction =
  | { type: 'status'; status: 'done' | 'deferred' }
  | { type: 'feedback'; kind: FeedbackKind };

const STATUS_ACTIONS: { status: 'done' | 'deferred'; label: string; icon: ReactNode }[] = [
  { status: 'done', label: 'Done', icon: <Check className="h-4 w-4" /> },
  { status: 'deferred', label: 'Defer', icon: <Clock className="h-4 w-4" /> },
];

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
  title,
  onClick,
  disabled,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-ink-faint hover:text-ink hover:bg-surface-sunken transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

/**
 * The per-item action row shared by Priorities cards and Debrief items:
 * Done / Defer, then the feedback signals, with a transient confirmation note.
 */
export function QuickActionBar({
  onSetStatus,
  onFeedback,
  statusDisabled,
}: {
  /** Updates the linked task candidate; resolves when recorded. */
  onSetStatus: (status: 'done' | 'deferred') => unknown;
  /** POST /api/feedback — resolves when recorded. */
  onFeedback: (kind: FeedbackKind) => Promise<unknown>;
  /** Disables Done/Defer when the item has no linked task to update. */
  statusDisabled?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const setStatus = (status: 'done' | 'deferred') => {
    Promise.resolve(onSetStatus(status))
      .then(() => setNote(status === 'done' ? 'Marked done.' : 'Deferred.'))
      .catch(() => {});
  };

  const sendFeedback = (kind: FeedbackKind) => {
    setSending(true);
    onFeedback(kind)
      .then(() => setNote('Thanks — noted.'))
      .catch(() => {})
      .finally(() => setSending(false));
  };

  return (
    <div className="flex items-center gap-0.5 mt-3 pt-2 border-t border-surface-border/70">
      {STATUS_ACTIONS.map((a) => (
        <IconAction
          key={a.status}
          label={a.label}
          title={statusDisabled ? `${a.label} — unavailable, this item has no linked task` : a.label}
          disabled={statusDisabled}
          onClick={() => setStatus(a.status)}
        >
          {a.icon}
        </IconAction>
      ))}
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
      {note && <span className="ml-auto text-xs text-emerald-700 pr-1">{note}</span>}
    </div>
  );
}

/** Tracks a checkbox selection, pruned to the ids currently on the page. */
export function useSelection(ids: string[]) {
  const [raw, setRaw] = useState<ReadonlySet<string>>(() => new Set<string>());
  const selected = useMemo(() => new Set(ids.filter((id) => raw.has(id))), [ids, raw]);
  const toggle = (id: string) =>
    setRaw((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setRaw(new Set(ids));
  const deselectAll = () => setRaw(new Set());
  return { selected, toggle, selectAll, deselectAll };
}

/** Run one request per item, tolerating individual failures. */
export async function applyToEach<T>(
  items: T[],
  run: (item: T) => Promise<unknown>,
): Promise<{ ok: number; failed: number }> {
  const results = await Promise.allSettled(items.map(run));
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { ok: results.length - failed, failed };
}

export type BulkApplyResult = { applied: number; skipped?: number; failed?: number };

const BULK_ACTION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Choose an action…' },
  { value: 'status:done', label: 'Mark done' },
  { value: 'status:deferred', label: 'Defer' },
  ...FEEDBACK_ACTIONS.map((a) => ({ value: `feedback:${a.kind}`, label: a.label })),
];

function parseAction(value: string): QuickAction | null {
  const [type, rest] = value.split(':');
  if (type === 'status' && (rest === 'done' || rest === 'deferred')) {
    return { type: 'status', status: rest };
  }
  if (type === 'feedback' && rest !== undefined && rest !== '') {
    return { type: 'feedback', kind: rest as FeedbackKind };
  }
  return null;
}

function describeResult(res: BulkApplyResult): string {
  const parts = [`Applied to ${res.applied} item${res.applied === 1 ? '' : 's'}`];
  if (res.skipped) parts.push(`skipped ${res.skipped} without a linked task`);
  if (res.failed) parts.push(`${res.failed} failed`);
  return `${parts.join(' · ')}.`;
}

/**
 * Page-level bulk toolbar: Select All / Deselect All, an action picker, and
 * Apply to Selected / Apply to All. The page supplies `onApply` to run the
 * action against its items.
 */
export function BulkActionBar({
  total,
  selectedCount,
  onSelectAll,
  onDeselectAll,
  onApply,
}: {
  total: number;
  selectedCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onApply: (action: QuickAction, scope: 'selected' | 'all') => Promise<BulkApplyResult>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'selected' | 'all' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const apply = (scope: 'selected' | 'all') => {
    const action = parseAction(value);
    if (!action || busy) return;
    setBusy(scope);
    setMessage(null);
    onApply(action, scope)
      .then((res) => setMessage(describeResult(res)))
      .catch(() => setMessage('Something went wrong — try again.'))
      .finally(() => setBusy(null));
  };

  return (
    <div className="mb-6 rounded-xl border border-surface-border bg-surface-raised px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          Select All
        </Button>
        <Button variant="ghost" size="sm" disabled={selectedCount === 0} onClick={onDeselectAll}>
          Deselect All
        </Button>
        <span className="text-[12.5px] text-ink-muted tabular-nums">
          {selectedCount} of {total} selected
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={value}
            onChange={setValue}
            options={BULK_ACTION_OPTIONS}
            className="py-1.5 text-[13px]"
          />
          <Button
            size="sm"
            disabled={value === '' || selectedCount === 0 || busy !== null}
            loading={busy === 'selected'}
            onClick={() => apply('selected')}
          >
            Apply to Selected
          </Button>
          <Button
            size="sm"
            disabled={value === '' || total === 0 || busy !== null}
            loading={busy === 'all'}
            onClick={() => apply('all')}
          >
            Apply to All
          </Button>
        </div>
      </div>
      {message && <p className="mt-1.5 text-xs text-ink-muted">{message}</p>}
    </div>
  );
}
