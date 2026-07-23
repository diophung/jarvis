import type { SourceAccount, SourceCategory, SourceItem } from '@jarvis/core';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SourceCategoryIcon, SourceItemModal } from '../../components/domain.js';
import { Badge, Card, EmptyState, LoadingPane } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { smartTime } from '../../lib/format.js';

const FILTERS: { value: SourceCategory | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'email', label: 'Email' },
  { value: 'chat', label: 'Chat' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'storage', label: 'Cloud storage' },
  { value: 'upload', label: 'Uploads' },
];

/** "Recent items" — browse the latest normalized items across all sources. */
export function ItemsBrowser({ accounts }: { accounts: SourceAccount[] }) {
  const [category, setCategory] = useState<SourceCategory | ''>('');
  const [openItem, setOpenItem] = useState<string | null>(null);

  const items = useQuery({
    queryKey: ['source-items', category],
    queryFn: () =>
      api.get<{ items: SourceItem[] }>(
        `/api/sources/items?limit=30${category ? `&category=${category}` : ''}`,
      ),
  });

  const accountLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.id, a.displayName);
    return map;
  }, [accounts]);

  return (
    <section>
      <h2 className="text-base font-semibold mb-1">Recent items</h2>
      <p className="text-sm text-ink-muted mb-4">
        The latest items Jarvis has pulled in from your sources.
      </p>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setCategory(f.value)}
            className={clsx(
              'rounded-full px-3 py-1 text-[13px] transition-colors',
              category === f.value
                ? 'bg-jarvis-600 text-white'
                : 'border border-surface-border text-ink-muted hover:text-ink hover:border-jarvis-300',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <Card>
        {items.isLoading && <LoadingPane label="Loading items…" />}
        {items.data && items.data.items.length === 0 && (
          <EmptyState
            icon={<Inbox />}
            title="Nothing here yet"
            description="Sync a source above and its items will show up here."
          />
        )}
        {items.data && items.data.items.length > 0 && (
          <ul className="divide-y divide-surface-border">
            {items.data.items.map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => setOpenItem(item.id)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-sunken transition-colors"
                >
                  <span className="text-ink-faint shrink-0">
                    <SourceCategoryIcon category={item.category} />
                  </span>
                  <span className="flex-1 min-w-0 truncate text-sm font-medium">{item.title}</span>
                  <span className="hidden sm:block w-36 truncate text-[13px] text-ink-muted shrink-0">
                    {item.sender?.name ?? item.sender?.email ?? ''}
                  </span>
                  <span className="text-xs text-ink-faint whitespace-nowrap shrink-0">
                    {smartTime(item.itemTimestamp)}
                  </span>
                  <span className="hidden md:inline-flex shrink-0">
                    <Badge tone="neutral">
                      {accountLabels.get(item.accountId) ?? item.provider}
                    </Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <SourceItemModal itemId={openItem} onClose={() => setOpenItem(null)} />
    </section>
  );
}
