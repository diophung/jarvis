import type {
  Citation,
  ScoreSignal,
  SourceAttachment,
  SourceCategory,
  SourceItem,
} from '@donna/core';
import { useQuery } from '@tanstack/react-query';
import { Calendar, File, FileUp, HardDrive, Inbox, Mail, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { fullDate, smartTime } from '../lib/format.js';
import { Badge, LoadingPane, Markdown, Modal } from './ui.js';

export function SourceCategoryIcon({
  category,
  className = 'h-4 w-4',
}: {
  category: SourceCategory | string | null | undefined;
  className?: string;
}) {
  switch (category) {
    case 'email':
      return <Mail className={className} />;
    case 'chat':
      return <MessageCircle className={className} />;
    case 'calendar':
      return <Calendar className={className} />;
    case 'storage':
      return <HardDrive className={className} />;
    case 'upload':
      return <FileUp className={className} />;
    default:
      return <Inbox className={className} />;
  }
}

/** "Why this matters" — contributing scoring signals with weights. */
export function SignalsList({ signals }: { signals: ScoreSignal[] }) {
  if (!signals.length) return <p className="text-sm text-ink-muted">No scoring signals recorded.</p>;
  const sorted = [...signals].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return (
    <ul className="space-y-1.5">
      {sorted.map((s, i) => (
        <li key={`${s.key}-${i}`} className="flex items-start gap-2 text-sm">
          <span
            className={
              s.weight >= 0
                ? 'text-emerald-700 font-medium tabular-nums shrink-0 w-10 text-right'
                : 'text-red-600 font-medium tabular-nums shrink-0 w-10 text-right'
            }
          >
            {s.weight >= 0 ? '+' : ''}
            {s.weight}
          </span>
          <span>
            {s.label}
            {s.detail && <span className="text-ink-muted"> — {s.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Modal showing a normalized source item with provenance. */
export function SourceItemModal({
  itemId,
  onClose,
}: {
  itemId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['source-item', itemId],
    queryFn: () =>
      api.get<{ item: SourceItem; attachments: SourceAttachment[] }>(
        `/api/sources/items/${itemId}`,
      ),
    enabled: !!itemId,
  });
  return (
    <Modal open={!!itemId} onClose={onClose} title={data?.item.title ?? 'Source item'} wide>
      {isLoading && <LoadingPane />}
      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <SourceCategoryIcon category={data.item.category} />
            <Badge tone="neutral">{data.item.provider}</Badge>
            <span>{fullDate(data.item.itemTimestamp)}</span>
            {data.item.dueAt && <Badge tone="amber">due {smartTime(data.item.dueAt)}</Badge>}
          </div>
          {data.item.sender && (
            <div className="text-sm">
              <span className="text-ink-muted">From: </span>
              {data.item.sender.name ?? data.item.sender.email}
              {data.item.sender.email && data.item.sender.name && (
                <span className="text-ink-faint"> &lt;{data.item.sender.email}&gt;</span>
              )}
            </div>
          )}
          {data.item.participants.length > 0 && (
            <div className="text-sm text-ink-muted">
              With: {data.item.participants.map((p) => p.name ?? p.email).filter(Boolean).join(', ')}
            </div>
          )}
          <div className="border-t border-surface-border pt-3">
            {data.item.bodyText ? (
              <Markdown>{data.item.bodyText}</Markdown>
            ) : (
              <p className="text-sm text-ink-muted">{data.item.snippet ?? 'No content.'}</p>
            )}
          </div>
          {data.attachments.length > 0 && (
            <div className="border-t border-surface-border pt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
                Attachments
              </div>
              <ul className="space-y-1">
                {data.attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-sm">
                    <File className="h-3.5 w-3.5 text-ink-faint" />
                    {a.filename}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.item.url && (
            <a
              href={data.item.url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm text-donna-700 underline"
            >
              Open in {data.item.provider} ↗
            </a>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Citation chips under an assistant message; click opens the source. */
export function CitationChips({ citations }: { citations: Citation[] }) {
  const [openItem, setOpenItem] = useState<string | null>(null);
  if (!citations.length) return null;
  return (
    <>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {citations.map((c, i) => (
          <button
            key={`${c.refId}-${i}`}
            onClick={() => {
              if (c.sourceType === 'source_item') setOpenItem(c.refId);
              else if (c.url) window.open(c.url, '_blank');
            }}
            title={c.snippet ?? c.title}
            className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface-raised px-2 py-0.5 text-[11px] text-ink-muted hover:border-donna-300 hover:text-ink transition-colors"
          >
            <span className="text-donna-600 font-semibold">{i + 1}</span>
            <span className="max-w-[180px] truncate">{c.title}</span>
            {c.sourceLabel && <span className="text-ink-faint">· {c.sourceLabel}</span>}
          </button>
        ))}
      </div>
      <SourceItemModal itemId={openItem} onClose={() => setOpenItem(null)} />
    </>
  );
}
