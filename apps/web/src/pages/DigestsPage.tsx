import type { Digest, DigestStatus } from '@donna/core';
import { DIGEST_SECTION_LABELS, DIGEST_SECTIONS } from '@donna/core';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, History, Sun } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, LoadingPane, PageHeader } from '../components/ui.js';
import { api } from '../lib/api.js';
import { fullDate } from '../lib/format.js';

const STATUS_TONES: Record<DigestStatus, 'green' | 'blue' | 'red'> = {
  ready: 'green',
  generating: 'blue',
  error: 'red',
};

/** Digest history — every debrief Donna has generated, newest first. */
export function DigestsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['digests'],
    queryFn: () => api.get<{ items: Digest[] }>('/api/digests'),
  });

  const items = data?.items ?? [];
  // A digest is "superseded" when a newer one in the list points back at it.
  const supersededIds = new Set(
    items.map((d) => d.supersedesDigestId).filter((id): id is string => id !== null),
  );

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <PageHeader
        title="Digest History"
        subtitle="Every debrief Donna has generated, newest first. Regenerated versions never overwrite older ones."
      />

      {isLoading ? (
        <LoadingPane label="Loading digests…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="No digests yet"
          description="Once Donna generates your first daily debrief it will be kept here, along with every later version."
          action={
            <Link
              to="/debrief"
              className="inline-flex items-center gap-1.5 rounded-lg bg-donna-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-donna-700 transition-colors"
            >
              <Sun className="h-4 w-4" /> Go to Daily Debrief
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((digest) => {
            const sectionCounts = DIGEST_SECTIONS.map((section) => ({
              section,
              count: digest.stats[section] ?? 0,
            })).filter((s) => s.count > 0);
            return (
              <Link
                key={digest.id}
                to={`/digests/${digest.id}`}
                className="group block rounded-xl border border-surface-border bg-surface-raised p-4 transition-colors hover:border-donna-300"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14.5px] font-medium">
                    {fullDate(digest.generatedAt) || 'Not generated yet'}
                  </span>
                  <Badge tone="accent">{digest.kind}</Badge>
                  <Badge tone={STATUS_TONES[digest.status]}>{digest.status}</Badge>
                  {supersededIds.has(digest.id) && <Badge tone="amber">superseded</Badge>}
                  <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-ink-faint transition-colors group-hover:text-donna-600" />
                </div>
                {sectionCounts.length > 0 && (
                  <p className="mt-1.5 text-[13px] text-ink-muted">
                    {sectionCounts.map((s, i) => (
                      <span key={s.section}>
                        {i > 0 && <span className="text-ink-faint"> · </span>}
                        {DIGEST_SECTION_LABELS[s.section]}{' '}
                        <span className="font-medium tabular-nums text-ink">{s.count}</span>
                      </span>
                    ))}
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
