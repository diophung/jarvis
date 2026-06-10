import { describe, expect, it } from 'vitest';
import type { PolicyRule } from './types.js';
import { capabilityMatches, evaluatePolicy } from './engine.js';

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'pol_1',
    capability: 'email.send',
    effect: 'deny',
    scope: {},
    enabled: 1,
    ...overrides,
  };
}

describe('capabilityMatches', () => {
  it('matches exact capability ids', () => {
    expect(capabilityMatches('email.send', 'email.send')).toBe(true);
    expect(capabilityMatches('email.send', 'email.reply')).toBe(false);
  });

  it('matches prefix wildcards', () => {
    expect(capabilityMatches('email.*', 'email.send')).toBe(true);
    expect(capabilityMatches('email.*', 'email.reply')).toBe(true);
    expect(capabilityMatches('email.*', 'emailx.send')).toBe(false);
    expect(capabilityMatches('email.*', 'email')).toBe(false);
    expect(capabilityMatches('email.*', 'calendar.update')).toBe(false);
  });

  it('matches the global wildcard against anything', () => {
    expect(capabilityMatches('*', 'email.send')).toBe(true);
    expect(capabilityMatches('*', 'source.read')).toBe(true);
    expect(capabilityMatches('*', 'made.up.capability')).toBe(true);
  });
});

describe('evaluatePolicy — rule resolution', () => {
  it('exact deny beats wildcard allow', () => {
    const rules: PolicyRule[] = [
      rule({ id: 'pol_allow', capability: 'email.*', effect: 'auto_approve' }),
      rule({ id: 'pol_deny', capability: 'email.send', effect: 'deny' }),
    ];
    const decision = evaluatePolicy({ capability: 'email.send' }, rules);
    expect(decision.effect).toBe('deny');
    expect(decision.matchedPolicyId).toBe('pol_deny');
    expect(decision.reason).toContain('Matched your rule');
  });

  it('the longest prefix wildcard wins over the global wildcard', () => {
    const rules: PolicyRule[] = [
      rule({ id: 'pol_global', capability: '*', effect: 'deny' }),
      rule({ id: 'pol_email', capability: 'email.*', effect: 'auto_approve' }),
    ];
    const decision = evaluatePolicy({ capability: 'email.send' }, rules);
    expect(decision.effect).toBe('auto_approve');
    expect(decision.matchedPolicyId).toBe('pol_email');
  });

  it('at equal specificity, deny > require_approval > auto_approve', () => {
    const rules: PolicyRule[] = [
      rule({ id: 'pol_a', capability: 'email.send', effect: 'auto_approve' }),
      rule({ id: 'pol_b', capability: 'email.send', effect: 'require_approval' }),
    ];
    expect(evaluatePolicy({ capability: 'email.send' }, rules).effect).toBe('require_approval');

    const withDeny: PolicyRule[] = [
      ...rules,
      rule({ id: 'pol_c', capability: 'email.send', effect: 'deny' }),
    ];
    const decision = evaluatePolicy({ capability: 'email.send' }, withDeny);
    expect(decision.effect).toBe('deny');
    expect(decision.matchedPolicyId).toBe('pol_c');
  });

  it('skips a rule whose scope provider does not match', () => {
    const rules: PolicyRule[] = [
      rule({ id: 'pol_outlook', effect: 'auto_approve', scope: { provider: 'outlook' } }),
    ];
    const decision = evaluatePolicy({ capability: 'email.send', provider: 'gmail' }, rules);
    expect(decision.matchedPolicyId).toBeNull();
    expect(decision.effect).toBe('require_approval'); // catalog default for email.send
  });

  it('applies a rule whose scope provider and accountId match', () => {
    const rules: PolicyRule[] = [
      rule({
        id: 'pol_scoped',
        effect: 'auto_approve',
        scope: { provider: 'gmail', accountId: 'acc_1' },
      }),
    ];
    const decision = evaluatePolicy(
      { capability: 'email.send', provider: 'gmail', accountId: 'acc_1' },
      rules,
    );
    expect(decision.matchedPolicyId).toBe('pol_scoped');
    expect(decision.effect).toBe('auto_approve');

    const mismatch = evaluatePolicy(
      { capability: 'email.send', provider: 'gmail', accountId: 'acc_2' },
      rules,
    );
    expect(mismatch.matchedPolicyId).toBeNull();
  });

  it('skips disabled rules', () => {
    const rules: PolicyRule[] = [rule({ id: 'pol_off', effect: 'auto_approve', enabled: 0 })];
    const decision = evaluatePolicy({ capability: 'email.send' }, rules);
    expect(decision.matchedPolicyId).toBeNull();
    expect(decision.effect).toBe('require_approval');
  });

  it('keeps riskLevel from the catalog even when a rule decides', () => {
    const rules: PolicyRule[] = [rule({ id: 'pol_x', effect: 'auto_approve' })];
    const decision = evaluatePolicy({ capability: 'email.send' }, rules);
    expect(decision.riskLevel).toBe('high');
    expect(decision.unknownCapability).toBe(false);
  });
});

describe('evaluatePolicy — catalog defaults and unknown capabilities', () => {
  it('defaults email.send to require_approval (high risk, externally visible)', () => {
    const decision = evaluatePolicy({ capability: 'email.send' }, []);
    expect(decision.effect).toBe('require_approval');
    expect(decision.riskLevel).toBe('high');
    expect(decision.matchedPolicyId).toBeNull();
    expect(decision.unknownCapability).toBe(false);
    expect(decision.reason).toContain('Default policy');
    expect(decision.reason).toContain('externally visible');
  });

  it('defaults source.read to auto_approve (safe)', () => {
    const decision = evaluatePolicy({ capability: 'source.read' }, []);
    expect(decision.effect).toBe('auto_approve');
    expect(decision.riskLevel).toBe('safe');
    expect(decision.matchedPolicyId).toBeNull();
    expect(decision.reason).toContain('Default policy');
  });

  it('treats unknown capabilities as require_approval at high risk', () => {
    const decision = evaluatePolicy({ capability: 'teleport.user' }, []);
    expect(decision).toEqual({
      effect: 'require_approval',
      riskLevel: 'high',
      matchedPolicyId: null,
      reason: expect.stringContaining('teleport.user') as unknown as string,
      unknownCapability: true,
    });
  });

  it('never auto-approves an unknown capability, even via a matching rule', () => {
    const rules: PolicyRule[] = [rule({ id: 'pol_all', capability: '*', effect: 'auto_approve' })];
    const decision = evaluatePolicy({ capability: 'teleport.user' }, rules);
    expect(decision.effect).toBe('require_approval');
    expect(decision.unknownCapability).toBe(true);
    expect(decision.riskLevel).toBe('high');
  });

  it('still allows an explicit deny of an unknown capability', () => {
    const rules: PolicyRule[] = [rule({ id: 'pol_no', capability: '*', effect: 'deny' })];
    const decision = evaluatePolicy({ capability: 'teleport.user' }, rules);
    expect(decision.effect).toBe('deny');
    expect(decision.matchedPolicyId).toBe('pol_no');
  });

  it('is deterministic', () => {
    const rules: PolicyRule[] = [
      rule({ id: 'pol_a', capability: 'email.*', effect: 'require_approval' }),
      rule({ id: 'pol_b', capability: '*', effect: 'deny' }),
    ];
    const a = evaluatePolicy({ capability: 'email.reply', provider: 'gmail' }, rules);
    const b = evaluatePolicy({ capability: 'email.reply', provider: 'gmail' }, rules);
    expect(a).toEqual(b);
  });
});
