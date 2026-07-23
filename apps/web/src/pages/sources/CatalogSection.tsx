import type { ConnectorCapability, SourceAccount, SourceCategory } from '@jarvis/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Badge, Button, Card, LoadingPane } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import {
  GOOGLE_SOURCE_ACCESS,
  googleSourceStartUrl,
  isGoogleSourceType,
  oauthPrimaryLinkClass,
} from './google-oauth.js';

/**
 * Shape of `GET /api/sources/catalog` entries: the connector descriptor from
 * `@jarvis/connectors` plus whether its required env is configured. Mirrored
 * here because the web app only depends on `@jarvis/core`.
 */
export interface CatalogConnector {
  provider: string;
  category: SourceCategory;
  label: string;
  description: string;
  capabilities: ConnectorCapability[];
  scopes: string[];
  requiredEnv: string[];
  local: boolean;
  configured: boolean;
  /** True for Google sources connectable via per-source OAuth (gmail / drive / calendar). */
  oauthConnectable?: boolean;
}

export const SOURCE_CATEGORY_LABELS: Record<SourceCategory, string> = {
  email: 'Email',
  chat: 'Chat',
  calendar: 'Calendar',
  storage: 'Cloud storage',
  upload: 'Uploads',
};

const CATEGORY_ORDER: SourceCategory[] = ['email', 'chat', 'calendar', 'storage'];

function ConnectorCard({
  connector,
  connecting,
  returnTo,
  onConnect,
}: {
  connector: CatalogConnector;
  connecting: boolean;
  /** In-app path the OAuth callback should land on (current page). */
  returnTo: string;
  onConnect: () => void;
}) {
  const oauthSource =
    connector.oauthConnectable && connector.configured && isGoogleSourceType(connector.provider)
      ? connector.provider
      : null;
  const gated = !connector.local && !connector.configured && !oauthSource;
  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm">{connector.label}</span>
        {connector.local && <Badge tone="accent">demo</Badge>}
      </div>
      <p className="text-[13px] text-ink-muted leading-snug">{connector.description}</p>
      <div className="flex flex-wrap gap-1">
        {connector.capabilities.map((cap) => (
          <Badge key={cap} tone="neutral" className="text-[10px] px-1.5">
            {cap}
          </Badge>
        ))}
      </div>
      <p className="text-[11px] text-ink-faint">
        {connector.scopes.length > 0
          ? `Scopes: ${connector.scopes.join(', ')}`
          : 'No external scopes needed'}
      </p>
      <div className="mt-auto pt-1 space-y-1.5">
        {oauthSource ? (
          <>
            <a href={googleSourceStartUrl(oauthSource, returnTo)} className={oauthPrimaryLinkClass}>
              Connect with Google
            </a>
            <p className="text-[11px] text-ink-muted">{GOOGLE_SOURCE_ACCESS[oauthSource]}</p>
          </>
        ) : connector.local ? (
          <Button variant="primary" size="sm" loading={connecting} onClick={onConnect}>
            Connect demo source
          </Button>
        ) : (
          <Button size="sm" disabled={gated} loading={connecting} onClick={onConnect}>
            Connect
          </Button>
        )}
        {gated && (
          <p className="text-[11px] text-amber-700">
            Requires env: {connector.requiredEnv.join(', ')} · see docs/connectors.md
          </p>
        )}
      </div>
    </Card>
  );
}

/** "Add a source" — the connector catalog, grouped by category. */
export function CatalogSection() {
  const qc = useQueryClient();
  const location = useLocation();
  const catalog = useQuery({
    queryKey: ['source-catalog'],
    queryFn: () => api.get<{ items: CatalogConnector[] }>('/api/sources/catalog'),
  });

  const connect = useMutation({
    mutationFn: (provider: string) =>
      api.post<{ account: SourceAccount }>('/api/sources/accounts', { provider }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['source-accounts'] });
    },
  });

  const items = catalog.data?.items ?? [];
  const groups = new Map<string, CatalogConnector[]>();
  for (const c of items) {
    const list = groups.get(c.category);
    if (list) list.push(c);
    else groups.set(c.category, [c]);
  }
  const orderedCategories: string[] = [
    ...CATEGORY_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((k) => !(CATEGORY_ORDER as string[]).includes(k)),
  ];

  return (
    <section className="mb-10">
      <h2 className="text-base font-semibold mb-1">Add a source</h2>
      <p className="text-sm text-ink-muted mb-4">
        Demo sources run locally with realistic sample data — real connectors activate once their
        environment variables are set.
      </p>
      {catalog.isLoading && <LoadingPane label="Loading catalog…" />}
      {!catalog.isLoading && items.length === 0 && (
        <p className="text-sm text-ink-muted flex items-center gap-2">
          <Plug className="h-4 w-4" /> No connectors available.
        </p>
      )}
      <div className="space-y-6">
        {orderedCategories.map((category) => {
          const connectors = groups.get(category);
          if (!connectors) return null;
          return (
            <div key={category}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">
                {SOURCE_CATEGORY_LABELS[category as SourceCategory] ?? category}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {connectors.map((c) => (
                  <ConnectorCard
                    key={c.provider}
                    connector={c}
                    connecting={connect.isPending && connect.variables === c.provider}
                    returnTo={location.pathname}
                    onConnect={() => connect.mutate(c.provider)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {connect.isError && (
        <p className="text-sm text-red-600 mt-3">
          Could not connect: {connect.error instanceof Error ? connect.error.message : 'unknown error'}
        </p>
      )}
    </section>
  );
}
