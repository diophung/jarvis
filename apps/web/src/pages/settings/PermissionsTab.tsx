import type { CapabilityDef, PermissionPolicy, PolicyEffect, RiskLevel } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, LoadingPane, Modal, Select } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { SettingsSection } from './shared.js';

const EFFECT_OPTIONS: { value: PolicyEffect; label: string }[] = [
  { value: 'auto_approve', label: 'Allowed automatically' },
  { value: 'require_approval', label: 'Ask me first' },
  { value: 'deny', label: 'Never allow' },
];

const GROUPS: { label: string; groups: CapabilityDef['group'][] }[] = [
  { label: 'Reading & analysis', groups: ['read', 'analyze'] },
  { label: 'Local drafts & notes', groups: ['create_local'] },
  { label: 'External actions', groups: ['create_external'] },
  { label: 'Changes & deletions', groups: ['modify', 'destructive'] },
];

const RISK_TONES: Record<RiskLevel, 'green' | 'blue' | 'amber' | 'red' | 'neutral'> = {
  safe: 'green',
  low: 'blue',
  medium: 'amber',
  high: 'red',
  critical: 'red',
};

/** Lowercase the first letter so the label reads naturally mid-sentence. */
function lc(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export function PermissionsTab() {
  const qc = useQueryClient();
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['policy-catalog'],
    queryFn: () => api.get<{ items: CapabilityDef[] }>('/api/policies/catalog'),
  });
  const { data: policies, isLoading: policiesLoading } = useQuery({
    queryKey: ['policies'],
    queryFn: () => api.get<{ items: PermissionPolicy[] }>('/api/policies'),
  });
  const [confirming, setConfirming] = useState<CapabilityDef | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['policies'] });
  const putPolicy = useMutation({
    mutationFn: ({ capability, effect }: { capability: string; effect: PolicyEffect }) =>
      api.put<{ policy: PermissionPolicy }>(
        `/api/policies/${encodeURIComponent(capability)}`,
        { effect },
      ),
    onSuccess: invalidate,
  });
  const resetPolicy = useMutation({
    mutationFn: (policyId: string) => api.del(`/api/policies/${policyId}`),
    onSuccess: invalidate,
  });

  if (catalogLoading || policiesLoading) return <LoadingPane label="Loading permissions…" />;

  const policyFor = (capabilityId: string) =>
    (policies?.items ?? []).find((p) => p.capability === capabilityId && p.enabled === 1);

  const onEffectChange = (cap: CapabilityDef, effect: PolicyEffect) => {
    if (effect === 'auto_approve' && cap.externallyVisible) {
      setConfirming(cap);
      return;
    }
    putPolicy.mutate({ capability: cap.id, effect });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2.5 rounded-xl border border-surface-border bg-surface-raised px-4 py-3 text-sm">
        <ShieldCheck className="h-4 w-4 mt-0.5 text-donna-600 shrink-0" />
        <p>
          You are in control. Safe read-only analysis is automatic; anything visible to others asks
          first by default.
        </p>
      </div>

      {GROUPS.map((group) => {
        const caps = (catalog?.items ?? []).filter((c) => group.groups.includes(c.group));
        if (caps.length === 0) return null;
        return (
          <SettingsSection key={group.label} title={group.label}>
            <div className="divide-y divide-surface-border/60">
              {caps.map((cap) => {
                const policy = policyFor(cap.id);
                const customized = policy != null && policy.createdBy !== 'default';
                const effect = policy?.effect ?? cap.defaultEffect;
                return (
                  <div
                    key={cap.id}
                    data-testid={`cap-row-${cap.id}`}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{cap.label}</span>
                        <Badge tone={RISK_TONES[cap.risk]}>{cap.risk} risk</Badge>
                        {customized && <Badge tone="accent">customized</Badge>}
                      </div>
                      <p className="text-[13px] text-ink-muted mt-0.5">{cap.description}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={effect}
                        onChange={(v) => onEffectChange(cap, v as PolicyEffect)}
                        options={EFFECT_OPTIONS}
                        className="w-52 py-1.5"
                      />
                      {customized && policy && (
                        <Button size="sm" variant="ghost" onClick={() => resetPolicy.mutate(policy.id)}>
                          Reset
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsSection>
        );
      })}

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Allow automatically?"
      >
        {confirming && (
          <>
            <p className="text-sm">
              Donna will be able to {lc(confirming.label)} without asking. You can change this
              anytime.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                variant="primary"
                loading={putPolicy.isPending}
                onClick={() =>
                  putPolicy.mutate(
                    { capability: confirming.id, effect: 'auto_approve' },
                    { onSuccess: () => setConfirming(null) },
                  )
                }
              >
                Allow automatically
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
