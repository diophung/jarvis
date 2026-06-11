import type { ConnectorRun, ConnectorRunStatus, SourceAccount, SourceAccountStatus } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { History, MoreHorizontal, RefreshCw, Unplug } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { SourceCategoryIcon } from '../../components/domain.js';
import { Badge, Button, Card, Spinner } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { smartTime, timeAgo } from '../../lib/format.js';
import {
  GOOGLE_SOURCE_ACCESS,
  googleSourceStartUrl,
  isGoogleSourceType,
  oauthPrimaryLinkClass,
  scopeLabel,
} from './google-oauth.js';

/**
 * `GET /api/sources/accounts` enriches accounts with OAuth fields
 * (docs/api-contract.md "Google source authorization"). Optional so the UI
 * degrades gracefully for env/local accounts.
 */
export type SourceAccountView = SourceAccount & {
  authKind?: 'oauth' | 'env' | 'local';
  grantedScopes?: string[];
};

const STATUS_BADGE: Record<
  SourceAccountStatus,
  { label: string; tone: 'green' | 'red' | 'amber' | 'neutral' }
> = {
  connected: { label: 'Connected', tone: 'green' },
  error: { label: 'Error', tone: 'red' },
  needs_auth: { label: 'Needs reauthorization', tone: 'amber' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

const RUN_DOT: Record<ConnectorRunStatus, string> = {
  running: 'bg-sky-500 animate-pulse',
  success: 'bg-emerald-500',
  partial: 'bg-amber-500',
  error: 'bg-red-500',
};

function MenuItem({
  icon: Icon,
  danger,
  onClick,
  children,
}: {
  icon: LucideIcon;
  danger?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-sunken transition-colors',
        danger ? 'text-red-600' : 'text-ink',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

function RunsList({ accountId }: { accountId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['source-runs', accountId],
    queryFn: () => api.get<{ items: ConnectorRun[] }>(`/api/sources/accounts/${accountId}/runs`),
  });
  return (
    <div className="border-t border-surface-border pt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">
        Recent runs
      </div>
      {isLoading && (
        <div className="flex justify-center py-2">
          <Spinner className="h-4 w-4" />
        </div>
      )}
      {data && data.items.length === 0 && (
        <p className="text-xs text-ink-muted">No sync runs yet.</p>
      )}
      {data && data.items.length > 0 && (
        <ul className="space-y-2">
          {data.items.map((run) => (
            <li key={run.id} className="text-xs">
              <div className="flex items-center gap-2">
                <span className={clsx('h-2 w-2 rounded-full shrink-0', RUN_DOT[run.status])} />
                <span className="text-ink whitespace-nowrap">{smartTime(run.startedAt)}</span>
                <span className="text-ink-muted truncate">
                  {run.itemsCreated} new · {run.itemsUpdated} updated ·{' '}
                  <span className={run.errorCount > 0 ? 'text-red-600' : undefined}>
                    {run.errorCount} {run.errorCount === 1 ? 'error' : 'errors'}
                  </span>
                </span>
              </div>
              {run.errors.length > 0 && (
                <ul className="mt-1 ml-4 space-y-0.5 text-red-600">
                  {run.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One connected source account: status, sync controls, run history, disconnect. */
export function AccountCard({ account }: { account: SourceAccountView }) {
  const qc = useQueryClient();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [lastRun, setLastRun] = useState<ConnectorRun | null>(null);

  const sync = useMutation({
    mutationFn: (mode: 'incremental' | 'full') =>
      api.post<{ run: ConnectorRun }>(`/api/sources/accounts/${account.id}/sync`, { mode }),
    onSuccess: (res) => {
      setLastRun(res.run);
      qc.invalidateQueries({ queryKey: ['source-accounts'] });
      qc.invalidateQueries({ queryKey: ['source-items'] });
      qc.invalidateQueries({ queryKey: ['source-runs', account.id] });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api.del<{ ok: boolean }>(`/api/sources/accounts/${account.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['source-accounts'] });
      qc.invalidateQueries({ queryKey: ['source-items'] });
    },
  });

  const status = STATUS_BADGE[account.status];
  const googleSource = isGoogleSourceType(account.provider) ? account.provider : null;
  const grantedScopes = account.grantedScopes ?? [];
  const disconnectMessage =
    googleSource || account.authKind === 'oauth'
      ? `Disconnect ${account.displayName}? Donna will stop syncing this source. Its stored Google access tokens will be revoked and removed.`
      : `Disconnect ${account.displayName}? Donna will stop syncing this source.`;

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-surface-sunken text-ink-muted flex items-center justify-center shrink-0">
          <SourceCategoryIcon category={account.category} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium truncate">{account.displayName}</span>
            <Badge tone="neutral">{account.provider}</Badge>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <p className="text-xs text-ink-muted mt-1">
            {account.lastSyncAt ? `Last synced ${timeAgo(account.lastSyncAt)}` : 'Never synced'}
          </p>
          {account.lastError && (
            <p className="text-xs text-red-600/80 truncate mt-1" title={account.lastError}>
              {account.lastError}
            </p>
          )}
          {grantedScopes.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {grantedScopes.map((scope) => (
                <Badge key={scope} tone="neutral" className="text-[10px] px-1.5">
                  {scopeLabel(scope)}
                </Badge>
              ))}
            </div>
          )}
          {googleSource && (
            <p className="text-xs text-ink-muted mt-1.5">{GOOGLE_SOURCE_ACCESS[googleSource]}</p>
          )}
        </div>
        <div className="relative shrink-0">
          <button
            aria-label={`Options for ${account.displayName}`}
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-surface-sunken transition-colors"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-8 z-20 w-44 rounded-lg border border-surface-border bg-surface-raised shadow-lg py-1">
                <MenuItem
                  icon={RefreshCw}
                  onClick={() => {
                    setMenuOpen(false);
                    sync.mutate('full');
                  }}
                >
                  Full sync
                </MenuItem>
                <MenuItem
                  icon={History}
                  onClick={() => {
                    setMenuOpen(false);
                    setRunsOpen((v) => !v);
                  }}
                >
                  Recent runs
                </MenuItem>
                <MenuItem
                  icon={Unplug}
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    if (window.confirm(disconnectMessage)) {
                      disconnect.mutate();
                    }
                  }}
                >
                  Disconnect
                </MenuItem>
              </div>
            </>
          )}
        </div>
      </div>

      {lastRun && (
        <div className="rounded-lg bg-surface-sunken px-3 py-2 text-[13px]">
          <div className="flex items-center gap-2">
            <span className={clsx('h-2 w-2 rounded-full shrink-0', RUN_DOT[lastRun.status])} />
            <span>
              {lastRun.itemsCreated} new, {lastRun.itemsUpdated} updated,{' '}
              <span className={lastRun.errorCount > 0 ? 'text-red-600 font-medium' : undefined}>
                {lastRun.errorCount} {lastRun.errorCount === 1 ? 'error' : 'errors'}
              </span>
            </span>
          </div>
          {lastRun.errors.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-xs text-red-600">
              {lastRun.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-auto">
        {googleSource && account.status === 'needs_auth' && (
          <a
            href={googleSourceStartUrl(googleSource, location.pathname)}
            className={oauthPrimaryLinkClass}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reconnect
          </a>
        )}
        <Button size="sm" onClick={() => sync.mutate('incremental')} loading={sync.isPending}>
          {!sync.isPending && <RefreshCw className="h-3.5 w-3.5" />}
          Sync now
        </Button>
      </div>

      {runsOpen && <RunsList accountId={account.id} />}
    </Card>
  );
}
