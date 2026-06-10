import type { SourceCategory } from '@donna/core';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, FileText, History, MessageSquare, Search as SearchIcon, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SourceCategoryIcon, SourceItemModal } from '../components/domain.js';
import { Badge, LoadingPane, EmptyState, PageHeader } from '../components/ui.js';
import { api } from '../lib/api.js';

/** Search result shape per docs/api-contract.md `GET /api/search`. */
interface SearchResultItem {
  chunkId: string;
  sourceType: 'source_item' | 'uploaded_file' | 'memory' | 'digest' | 'message';
  refId: string;
  title: string;
  snippet: string;
  score: number;
  matchType: 'keyword' | 'semantic' | 'both';
  sourceLabel?: string;
  category?: SourceCategory;
  url?: string;
}

interface SearchResponse {
  results: SearchResultItem[];
  mode: 'keyword' | 'semantic+keyword';
}

const TYPE_FILTERS = [
  { value: 'source_item', label: 'Emails & messages' },
  { value: 'uploaded_file', label: 'Uploaded files' },
  { value: 'memory', label: 'Memories' },
  { value: 'digest', label: 'Digests' },
] as const;
type SearchType = (typeof TYPE_FILTERS)[number]['value'];

const MODE_TOOLTIP =
  'Semantic search needs an embedding-capable AI provider — without one, Donna matches keywords only.';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wrap query tokens found in `text` with <mark>. */
function highlightTokens(text: string, query: string): ReactNode {
  const tokens = Array.from(new Set(query.trim().split(/\s+/).filter((t) => t.length > 0)));
  if (tokens.length === 0) return text;
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
  // With a single capture group, matches land at odd indices after split.
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-donna-100 text-inherit rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function ResultIcon({ result }: { result: SearchResultItem }) {
  switch (result.sourceType) {
    case 'source_item':
      return <SourceCategoryIcon category={result.category} className="h-4 w-4" />;
    case 'uploaded_file':
      return <FileText className="h-4 w-4" />;
    case 'memory':
      return <ClipboardList className="h-4 w-4" />;
    case 'digest':
      return <History className="h-4 w-4" />;
    default:
      return <MessageSquare className="h-4 w-4" />;
  }
}

const MATCH_TONES: Record<SearchResultItem['matchType'], 'neutral' | 'blue' | 'green'> = {
  keyword: 'neutral',
  semantic: 'blue',
  both: 'green',
};

function ResultRow({
  result,
  query,
  onOpenItem,
}: {
  result: SearchResultItem;
  query: string;
  onOpenItem: (refId: string) => void;
}) {
  const inner = (
    <>
      <span className="mt-1 text-ink-faint shrink-0">
        <ResultIcon result={result} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="font-medium text-[15px] truncate">{result.title}</span>
          {result.sourceLabel && (
            <span className="text-xs text-ink-faint shrink-0">{result.sourceLabel}</span>
          )}
        </span>
        <span className="block text-sm text-ink-muted mt-0.5 leading-relaxed">
          {highlightTokens(result.snippet, query)}
        </span>
      </span>
      <span className="shrink-0 mt-1">
        <Badge tone={MATCH_TONES[result.matchType]}>{result.matchType}</Badge>
      </span>
    </>
  );
  const className =
    'flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left hover:bg-surface-sunken/70 hover:border-surface-border transition-colors';
  if (result.sourceType === 'source_item') {
    return (
      <button type="button" className={className} onClick={() => onOpenItem(result.refId)}>
        {inner}
      </button>
    );
  }
  const to =
    result.sourceType === 'uploaded_file'
      ? '/files'
      : result.sourceType === 'memory'
        ? '/memory'
        : result.sourceType === 'digest'
          ? `/digests/${result.refId}`
          : null;
  if (to) {
    return (
      <Link to={to} className={className}>
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [types, setTypes] = useState<SearchType[]>(TYPE_FILTERS.map((t) => t.value));
  const [openItemId, setOpenItemId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const toggleType = (value: SearchType) =>
    setTypes((prev) =>
      prev.includes(value)
        ? prev.filter((t) => t !== value)
        : TYPE_FILTERS.map((t) => t.value).filter((t) => t === value || prev.includes(t)),
    );

  const q = debounced.trim();
  const enabled = q.length > 0 && types.length > 0;
  const { data, isFetching } = useQuery({
    queryKey: ['search', q, types.join(',')],
    queryFn: () =>
      api.get<SearchResponse>(
        `/api/search?q=${encodeURIComponent(q)}&types=${types.join(',')}`,
      ),
    enabled,
  });

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <PageHeader title="Search" subtitle="Everything Donna knows, in one place." />

      <div className="relative">
        <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-ink-faint" />
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emails, files, memories, digests…"
          aria-label="Search"
          className="w-full rounded-xl border border-surface-border bg-surface-raised pl-11 pr-4 py-3 text-base placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-donna-300 focus:border-donna-400"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 mb-6">
        {TYPE_FILTERS.map((t) => (
          <label
            key={t.value}
            className="inline-flex items-center gap-1.5 text-sm text-ink-muted cursor-pointer select-none hover:text-ink"
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-donna-600"
              checked={types.includes(t.value)}
              onChange={() => toggleType(t.value)}
            />
            {t.label}
          </label>
        ))}
      </div>

      {!enabled && (
        <EmptyState
          icon={<SearchIcon />}
          title="Search everything Donna knows"
          description={
            types.length === 0
              ? 'Pick at least one type above, then start typing.'
              : 'Emails, messages, uploaded files, memories and digests — results appear as you type.'
          }
        />
      )}

      {enabled && isFetching && !data && <LoadingPane label="Searching…" />}

      {enabled && data && (
        <>
          <div className="flex items-center justify-between mb-2 px-3">
            <span className="text-sm text-ink-muted">
              {data.results.length} result{data.results.length === 1 ? '' : 's'}
            </span>
            <span title={MODE_TOOLTIP} className="cursor-help">
              <Badge tone={data.mode === 'keyword' ? 'neutral' : 'accent'}>{data.mode}</Badge>
            </span>
          </div>
          {data.results.length === 0 ? (
            <EmptyState
              icon={<SearchX />}
              title={`No results for “${q}”`}
              description="Try different keywords or broaden the type filters."
            />
          ) : (
            <div className="space-y-0.5">
              {data.results.map((r) => (
                <ResultRow
                  key={r.chunkId}
                  result={r}
                  query={q}
                  onOpenItem={setOpenItemId}
                />
              ))}
            </div>
          )}
        </>
      )}

      <SourceItemModal itemId={openItemId} onClose={() => setOpenItemId(null)} />
    </div>
  );
}
