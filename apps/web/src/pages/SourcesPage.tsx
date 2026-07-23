import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, Inbox, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, EmptyState, LoadingPane, PageHeader } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { SourceAccountView } from './sources/AccountCard.js';
import { AccountCard } from './sources/AccountCard.js';
import { CatalogSection } from './sources/CatalogSection.js';
import { sourceConnectedMessage, sourceErrorMessage } from './sources/google-oauth.js';
import { ItemsBrowser } from './sources/ItemsBrowser.js';

interface OauthBanner {
  tone: 'success' | 'error';
  text: string;
}

/**
 * Reads the `?connected=<sourceType>` / `?sourceError=<code>` params the
 * Google OAuth callback redirects back with, turns them into a banner, and
 * strips them from the URL so a refresh doesn't replay the message.
 */
function useOauthCallbackBanner(): [OauthBanner | null, () => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const [banner, setBanner] = useState<OauthBanner | null>(null);

  useEffect(() => {
    const connected = searchParams.get('connected');
    const sourceError = searchParams.get('sourceError');
    if (!connected && !sourceError) return;
    if (connected) {
      setBanner({ tone: 'success', text: sourceConnectedMessage(connected) });
    } else if (sourceError) {
      setBanner({ tone: 'error', text: sourceErrorMessage(sourceError) });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('sourceError');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return [banner, () => setBanner(null)];
}

/** /sources — connected accounts, the connector catalog, and recent items. */
export function SourcesPage() {
  const [banner, dismissBanner] = useOauthCallbackBanner();
  const accounts = useQuery({
    queryKey: ['source-accounts'],
    queryFn: () => api.get<{ items: SourceAccountView[] }>('/api/sources/accounts'),
  });

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <PageHeader
        title="Connected sources"
        subtitle="Everything Jarvis can see — email, chat, calendar, and cloud storage."
      />

      {banner && (
        <div
          role={banner.tone === 'error' ? 'alert' : 'status'}
          className={clsx(
            'mb-6 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm',
            banner.tone === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800',
          )}
        >
          {banner.tone === 'error' ? (
            <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <span className="flex-1">{banner.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissBanner}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {accounts.isLoading ? (
        <LoadingPane label="Loading sources…" />
      ) : accounts.data && accounts.data.items.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 mb-10">
          {accounts.data.items.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      ) : (
        <Card className="mb-10">
          <EmptyState
            icon={<Inbox />}
            title="No sources connected yet"
            description="Connect a source below — demo sources work instantly, no credentials needed."
          />
        </Card>
      )}

      <CatalogSection />

      <ItemsBrowser accounts={accounts.data?.items ?? []} />
    </div>
  );
}
