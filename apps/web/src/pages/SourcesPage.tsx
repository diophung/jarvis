import type { SourceAccount } from '@donna/core';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { Card, EmptyState, LoadingPane, PageHeader } from '../components/ui.js';
import { api } from '../lib/api.js';
import { AccountCard } from './sources/AccountCard.js';
import { CatalogSection } from './sources/CatalogSection.js';
import { ItemsBrowser } from './sources/ItemsBrowser.js';

/** /sources — connected accounts, the connector catalog, and recent items. */
export function SourcesPage() {
  const accounts = useQuery({
    queryKey: ['source-accounts'],
    queryFn: () => api.get<{ items: SourceAccount[] }>('/api/sources/accounts'),
  });

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <PageHeader
        title="Connected sources"
        subtitle="Everything Donna can see — email, chat, calendar, and cloud storage."
      />

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
