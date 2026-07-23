import type { ActorType, AuditEventType, AuditLog } from '@jarvis/core';
import { ACTOR_TYPES } from '@jarvis/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingPane,
  PageHeader,
  Select,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { fullDate, timeAgo } from '../lib/format.js';

const PAGE_SIZE = 50;

/** Frequently seen event types, always offered in the filter. */
const COMMON_EVENT_TYPES: AuditEventType[] = [
  'connector.sync',
  'llm.call',
  'digest.generated',
  'approval.created',
  'approval.approved',
  'approval.denied',
  'agent.action.proposed',
  'agent.action.executed',
  'agent.action.failed',
  'memory.created',
  'memory.updated',
  'policy.updated',
  'settings.updated',
  'auth.login',
];

function dotColor(eventType: string): string {
  if (eventType.startsWith('approval.')) return 'bg-amber-500';
  if (eventType.startsWith('agent.')) return 'bg-red-400';
  if (eventType === 'llm.call') return 'bg-sky-500';
  if (eventType.startsWith('connector.')) return 'bg-emerald-500';
  if (eventType.startsWith('memory.')) return 'bg-violet-500';
  return 'bg-ink-faint';
}

const ACTOR_TONES: Record<ActorType, 'blue' | 'amber' | 'neutral'> = {
  user: 'blue',
  agent: 'amber',
  system: 'neutral',
  worker: 'neutral',
};

export function AuditPage() {
  const [eventType, setEventType] = useState('');
  const [actor, setActor] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useInfiniteQuery({
    queryKey: ['audit', eventType, actor],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) params.set('before', pageParam);
      if (eventType) params.set('eventType', eventType);
      if (actor) params.set('actor', actor);
      return api.get<{ items: AuditLog[] }>(`/api/audit?${params.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (lastPage) => {
      if (lastPage.items.length < PAGE_SIZE) return undefined;
      const lastItem = lastPage.items[lastPage.items.length - 1];
      return lastItem?.createdAt;
    },
  });

  const items = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  const eventTypeOptions = useMemo(() => {
    const known = new Set<string>(COMMON_EVENT_TYPES);
    for (const item of items) known.add(item.eventType);
    if (eventType) known.add(eventType);
    return [
      { value: '', label: 'All events' },
      ...Array.from(known)
        .sort()
        .map((v) => ({ value: v, label: v })),
    ];
  }, [items, eventType]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <PageHeader
        title="Audit Log"
        subtitle="Every sync, model call, approval, and action — recorded."
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Select value={eventType} onChange={setEventType} options={eventTypeOptions} />
        <Select
          value={actor}
          onChange={setActor}
          options={[
            { value: '', label: 'All actors' },
            ...ACTOR_TYPES.map((a) => ({ value: a, label: a })),
          ]}
        />
      </div>

      {query.isLoading ? (
        <LoadingPane />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title="No audit events"
          description="Activity will appear here as Jarvis syncs, thinks, and acts."
        />
      ) : (
        <>
          <Card>
            <div className="divide-y divide-surface-border">
              {items.map((log) => {
                const isOpen = expanded.has(log.id);
                const hasMeta = Object.keys(log.metadata ?? {}).length > 0;
                return (
                  <div key={log.id}>
                    <button
                      type="button"
                      onClick={() => toggle(log.id)}
                      className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-sunken/60 transition-colors"
                    >
                      <span
                        className={clsx(
                          'mt-1.5 h-2 w-2 rounded-full shrink-0',
                          dotColor(log.eventType),
                        )}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-ink-muted">
                            {log.eventType}
                          </span>
                          <Badge tone={ACTOR_TONES[log.actor]}>{log.actor}</Badge>
                          {log.capability && (
                            <span className="font-mono text-[11px] text-ink-faint">
                              {log.capability}
                            </span>
                          )}
                        </span>
                        <span className="block text-sm text-ink mt-0.5">{log.summary}</span>
                      </span>
                      <span
                        className="text-xs text-ink-faint shrink-0"
                        title={fullDate(log.createdAt)}
                      >
                        {timeAgo(log.createdAt)}
                      </span>
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-ink-faint mt-1 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-ink-faint mt-1 shrink-0" />
                      )}
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-3 pl-9">
                        {hasMeta ? (
                          <pre className="font-mono text-xs bg-surface-sunken border border-surface-border rounded-lg p-3 overflow-x-auto">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        ) : (
                          <p className="text-xs text-ink-faint">No additional details.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
          {query.hasNextPage && (
            <div className="flex justify-center mt-4">
              <Button
                onClick={() => void query.fetchNextPage()}
                loading={query.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
