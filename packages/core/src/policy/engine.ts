/**
 * Permission policy engine.
 *
 * Resolution order:
 *  1. Enabled user rules whose capability pattern matches (exact `email.send`,
 *     prefix wildcard `email.*`, or global `*`) AND whose scope matches
 *     (scope.provider / scope.accountId equality when set).
 *  2. Most specific pattern wins: exact > longest prefix wildcard > `*`.
 *     At equal specificity: deny > require_approval > auto_approve.
 *  3. No rule matches -> the CAPABILITY_CATALOG default for the capability.
 *  4. Capability unknown to the catalog -> require_approval at high risk
 *     (and a matching rule may deny it, but never auto-approve it).
 *
 * `riskLevel` always comes from the catalog when the capability is known.
 * Pure and deterministic.
 */
import { getCapabilityDef, type CapabilityDef } from '../capabilities.js';
import type { PolicyEffect } from '../enums.js';
import type { PolicyDecision, PolicyRule, ProposedActionInput } from './types.js';

const EFFECT_RANK: Record<PolicyEffect, number> = {
  deny: 3,
  require_approval: 2,
  auto_approve: 1,
};

const EFFECT_PHRASES: Record<PolicyEffect, string> = {
  deny: 'never allow',
  require_approval: 'ask first',
  auto_approve: 'always allow',
};

/** True when a capability pattern (`email.send`, `email.*`, `*`) matches a capability id. */
export function capabilityMatches(pattern: string, capability: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // 'email.*' -> 'email.'
    return capability.startsWith(prefix) && capability.length > prefix.length;
  }
  return pattern === capability;
}

/** Higher = more specific. Exact match always beats any wildcard. */
function specificity(pattern: string, capability: string): number {
  if (pattern === capability) return Number.MAX_SAFE_INTEGER;
  if (pattern === '*') return 0;
  return pattern.length;
}

function scopeMatches(scope: Record<string, unknown>, input: ProposedActionInput): boolean {
  const provider = scope['provider'];
  if (provider !== undefined && provider !== null && provider !== input.provider) return false;
  const accountId = scope['accountId'];
  if (accountId !== undefined && accountId !== null && accountId !== input.accountId) return false;
  return true;
}

function lowerFirst(s: string): string {
  return s === '' ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function defaultReason(def: CapabilityDef): string {
  const label = lowerFirst(def.label);
  switch (def.defaultEffect) {
    case 'auto_approve':
      return `Default policy: ${label} is ${def.risk === 'safe' ? 'safe' : 'low-risk'} and runs without approval.`;
    case 'require_approval':
      return def.externallyVisible
        ? `Default policy: ${label} is externally visible and requires approval.`
        : `Default policy: ${label} requires your approval.`;
    case 'deny':
      return `Default policy: ${label} is not allowed.`;
  }
}

/** Decide what should happen to a proposed agent action. */
export function evaluatePolicy(input: ProposedActionInput, rules: PolicyRule[]): PolicyDecision {
  const def = getCapabilityDef(input.capability);
  const unknownCapability = def === undefined;
  const riskLevel = def?.risk ?? 'high';

  const candidates = rules.filter(
    (r) =>
      r.enabled === 1 &&
      capabilityMatches(r.capability, input.capability) &&
      scopeMatches(r.scope, input),
  );

  let best: PolicyRule | undefined;
  for (const rule of candidates) {
    if (best === undefined) {
      best = rule;
      continue;
    }
    const sBest = specificity(best.capability, input.capability);
    const sRule = specificity(rule.capability, input.capability);
    if (sRule > sBest || (sRule === sBest && EFFECT_RANK[rule.effect] > EFFECT_RANK[best.effect])) {
      best = rule;
    }
  }

  if (best !== undefined) {
    let effect = best.effect;
    let reason = `Matched your rule "${best.capability} → ${EFFECT_PHRASES[best.effect]}".`;
    if (unknownCapability && effect === 'auto_approve') {
      // Never silently auto-approve a capability the catalog has never heard of.
      effect = 'require_approval';
      reason = `Matched your rule "${best.capability}", but unknown capabilities are never auto-approved.`;
    }
    return { effect, riskLevel, matchedPolicyId: best.id, reason, unknownCapability };
  }

  if (def === undefined) {
    return {
      effect: 'require_approval',
      riskLevel: 'high',
      matchedPolicyId: null,
      reason: `Unknown capability "${input.capability}" — Jarvis asks for approval by default.`,
      unknownCapability: true,
    };
  }

  return {
    effect: def.defaultEffect,
    riskLevel: def.risk,
    matchedPolicyId: null,
    reason: defaultReason(def),
    unknownCapability: false,
  };
}
