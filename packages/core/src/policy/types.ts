/**
 * Permission/policy engine contracts. Decisions are made from the capability
 * catalog defaults plus user-defined PermissionPolicy rules (most-specific
 * match wins; `deny` always beats `auto_approve`).
 */
import type { PolicyEffect, RiskLevel } from '../enums.js';

export interface PolicyRule {
  id: string;
  /** Capability pattern: exact (`email.send`), prefix wildcard (`email.*`), or `*`. */
  capability: string;
  effect: PolicyEffect;
  scope: Record<string, unknown>;
  enabled: number;
}

export interface ProposedActionInput {
  capability: string;
  /** Optional context used to match policy scopes. */
  provider?: string;
  accountId?: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  riskLevel: RiskLevel;
  /** Which rule decided (null = catalog default). */
  matchedPolicyId: string | null;
  /** Human-readable explanation for audit + UI. */
  reason: string;
  /** True when the capability is unknown to the catalog (treated as high risk). */
  unknownCapability: boolean;
}
