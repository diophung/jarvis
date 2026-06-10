/**
 * Shared helpers for the governance pages (Approvals, Memory, Audit):
 * capability catalog lookup + risk badges.
 */
import type { CapabilityDef, RiskLevel } from '@donna/core';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '../../components/ui.js';
import { api } from '../../lib/api.js';

/** The capability catalog drives plain-language labels for raw capability ids. */
export function useCapabilityCatalog() {
  return useQuery({
    queryKey: ['policies', 'catalog'],
    queryFn: () => api.get<{ items: CapabilityDef[] }>('/api/policies/catalog'),
    staleTime: 10 * 60 * 1000,
  });
}

/** Plain-language label for a capability id, falling back to the raw id. */
export function capabilityLabel(
  catalog: CapabilityDef[] | undefined,
  capability: string,
): string {
  return catalog?.find((c) => c.id === capability)?.label ?? capability;
}

const RISK_TONES: Record<RiskLevel, 'green' | 'blue' | 'amber' | 'red'> = {
  safe: 'green',
  low: 'blue',
  medium: 'amber',
  high: 'red',
  critical: 'red',
};

/** Color-coded risk badge: safe (green) → critical (red). */
export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return (
    <Badge tone={RISK_TONES[risk]} className={risk === 'critical' ? 'font-semibold' : undefined}>
      {risk} risk
    </Badge>
  );
}
