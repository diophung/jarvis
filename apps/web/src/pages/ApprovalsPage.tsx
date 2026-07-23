import type { AgentAction, ApprovalRequest, ApprovalStatus, SourceAccount } from '@jarvis/core';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { Fragment, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingPane,
  PageHeader,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { fullDate, timeAgo } from '../lib/format.js';
import { RiskBadge, capabilityLabel, useCapabilityCatalog } from './govern/shared.js';

type Decision = 'approve' | 'deny';

interface DecideResponse {
  approval: ApprovalRequest;
  action?: AgentAction;
}

interface Outcome extends DecideResponse {
  decision: Decision;
}

const DECIDED_STATUSES = ['approved', 'denied', 'expired'] as const;

const STATUS_TONES: Record<ApprovalStatus, 'green' | 'red' | 'amber' | 'neutral'> = {
  pending: 'amber',
  approved: 'green',
  denied: 'red',
  expired: 'neutral',
  cancelled: 'neutral',
};

/** Best human-readable detail of an executed action result. */
function actionDetail(action: AgentAction): string {
  const result = action.result ?? {};
  for (const key of ['detail', 'message', 'externalRef', 'url', 'refId']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return action.actionType;
}

/** Inline result banner shown after a decision. */
function OutcomeBanner({ outcome, label }: { outcome: Outcome; label: string }) {
  const { action, decision } = outcome;
  if (decision === 'deny') {
    return (
      <div className="rounded-xl border border-surface-border bg-surface-sunken px-4 py-3 text-sm text-ink-muted flex items-center gap-2">
        <XCircle className="h-4 w-4 shrink-0" />
        <span>Denied — {label}. Nothing was done.</span>
      </div>
    );
  }
  if (action?.status === 'failed') {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>Failed — {action.error ?? 'the action could not be completed.'}</span>
      </div>
    );
  }
  if (action?.status === 'executed') {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>Done — {actionDetail(action)}</span>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      <span>Approved — {label}.</span>
    </div>
  );
}

function PendingCard({
  approval,
  label,
  accountName,
  onOutcome,
}: {
  approval: ApprovalRequest;
  label: string;
  accountName: string | null;
  onOutcome: (outcome: Outcome) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [alwaysAllow, setAlwaysAllow] = useState(false);

  const decide = useMutation({
    mutationFn: (decision: Decision) =>
      api.post<DecideResponse>(`/api/approvals/${approval.id}/decide`, {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(decision === 'approve' && alwaysAllow ? { alwaysAllow: true } : {}),
      }),
    onSuccess: (data, decision) => {
      onOutcome({ ...data, decision });
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const { preview } = approval;
  const fields = preview.fields ?? {};

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h3 className="font-medium text-ink">{label}</h3>
          <RiskBadge risk={approval.riskLevel} />
        </div>
        <span className="text-xs text-ink-faint shrink-0" title={fullDate(approval.requestedAt)}>
          requested {timeAgo(approval.requestedAt)}
        </span>
      </div>

      <p className="text-sm text-ink-muted">{approval.reason}</p>

      <div className="rounded-lg border border-surface-border bg-surface-sunken p-4">
        <p className="text-sm font-semibold text-ink">{preview.summary}</p>
        {preview.body && (
          <p className="mt-2 text-sm text-ink whitespace-pre-wrap">{preview.body}</p>
        )}
        {Object.keys(fields).length > 0 && (
          <dl className="mt-3 grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-xs">
            {Object.entries(fields).map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-ink-faint">{key}</dt>
                <dd className="text-ink-muted break-words">{value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        {approval.targetProvider && (
          <Badge tone="neutral">
            {approval.targetProvider}
            {accountName ? ` · ${accountName}` : ''}
          </Badge>
        )}
        {approval.expiresAt && (
          <span title={fullDate(approval.expiresAt)}>expires {timeAgo(approval.expiresAt)}</span>
        )}
      </div>

      {decide.isError && (
        <p className="text-sm text-red-600">
          Could not record your decision. {(decide.error as Error).message}
        </p>
      )}

      <div className="border-t border-surface-border pt-3 space-y-2.5">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
            className="h-4 w-4 rounded border-surface-border accent-jarvis-600"
          />
          Always allow this
        </label>
        {alwaysAllow && (
          <p className="text-xs text-amber-700">
            Future {label} actions will run without asking.
          </p>
        )}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Add a note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="flex-1"
          />
          <Button
            variant="secondary"
            onClick={() => decide.mutate('deny')}
            disabled={decide.isPending}
          >
            Deny
          </Button>
          <Button
            variant="primary"
            onClick={() => decide.mutate('approve')}
            loading={decide.isPending}
          >
            Approve
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function ApprovalsPage() {
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);

  const catalog = useCapabilityCatalog();
  const labelFor = (capability: string) => capabilityLabel(catalog.data?.items, capability);

  const pendingQ = useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: () => api.get<{ items: ApprovalRequest[] }>('/api/approvals?status=pending'),
  });

  const accountsQ = useQuery({
    queryKey: ['source-accounts'],
    queryFn: () => api.get<{ items: SourceAccount[] }>('/api/sources/accounts'),
    staleTime: 60 * 1000,
  });
  const accountName = (id: string | null) =>
    id ? (accountsQ.data?.items.find((a) => a.id === id)?.displayName ?? null) : null;

  const decidedQueries = useQueries({
    queries: DECIDED_STATUSES.map((status) => ({
      queryKey: ['approvals', 'status', status],
      queryFn: () => api.get<{ items: ApprovalRequest[] }>(`/api/approvals?status=${status}`),
      enabled: tab === 'decided',
    })),
  });
  const decided = decidedQueries
    .flatMap((q) => q.data?.items ?? [])
    .sort((a, b) =>
      (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt),
    );
  const decidedLoading = decidedQueries.some((q) => q.isLoading);

  const outcomeIds = new Set(outcomes.map((o) => o.approval.id));
  const pendingItems = (pendingQ.data?.items ?? []).filter((a) => !outcomeIds.has(a.id));

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <PageHeader
        title="Approvals"
        subtitle="Review what Jarvis wants to do on your behalf before anything leaves your hands."
      />

      <div className="flex gap-1 border-b border-surface-border mb-5">
        {(['pending', 'decided'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={clsx(
              'px-3 py-2 text-sm -mb-px border-b-2 transition-colors',
              tab === t
                ? 'border-jarvis-600 text-ink font-medium'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t === 'pending'
              ? `Pending${pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}`
              : 'Decided'}
          </button>
        ))}
      </div>

      {tab === 'pending' &&
        (pendingQ.isLoading ? (
          <LoadingPane />
        ) : (
          <div className="space-y-4">
            {outcomes.map((o) => (
              <OutcomeBanner
                key={o.approval.id}
                outcome={o}
                label={labelFor(o.approval.capability)}
              />
            ))}
            {pendingItems.length === 0 && outcomes.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck />}
                title="Nothing waiting on you."
                description="Jarvis asks before any external action."
              />
            ) : (
              pendingItems.map((approval) => (
                <PendingCard
                  key={approval.id}
                  approval={approval}
                  label={labelFor(approval.capability)}
                  accountName={accountName(approval.targetAccountId)}
                  onOutcome={(outcome) => setOutcomes((prev) => [outcome, ...prev])}
                />
              ))
            )}
          </div>
        ))}

      {tab === 'decided' &&
        (decidedLoading ? (
          <LoadingPane />
        ) : decided.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title="No decisions yet"
            description="Approvals you approve, deny, or let expire will show up here."
          />
        ) : (
          <Card className="divide-y divide-surface-border">
            {decided.map((approval) => (
              <div key={approval.id} className="flex items-center gap-3 px-4 py-3">
                <Badge tone={STATUS_TONES[approval.status]}>{approval.status}</Badge>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink truncate">
                    {labelFor(approval.capability)}
                  </div>
                  <div className="text-xs text-ink-muted truncate">
                    {approval.preview.summary}
                  </div>
                  {approval.decisionNote && (
                    <div className="text-xs text-ink-faint mt-0.5">
                      note: {approval.decisionNote}
                    </div>
                  )}
                </div>
                <span
                  className="text-xs text-ink-faint shrink-0"
                  title={fullDate(approval.decidedAt ?? approval.createdAt)}
                >
                  {timeAgo(approval.decidedAt ?? approval.createdAt)}
                </span>
              </div>
            ))}
          </Card>
        ))}
    </div>
  );
}
