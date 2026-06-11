import { describe, expect, it } from 'vitest';
import { resolvePersonalization } from './personalize.js';
import type { LearnedPreference } from './types.js';

function preference(partial: Partial<LearnedPreference>): LearnedPreference {
  return {
    id: 'lpr_1',
    workspaceId: 'wsp_1',
    userId: 'usr_1',
    category: 'communication_style',
    key: 'style.length',
    value: 'concise',
    statement: 'Tends to prefer concise messages',
    scope: {},
    origin: 'inferred',
    status: 'active',
    confidence: 0.7,
    evidenceCount: 6,
    evidenceWeight: 3,
    contradictionCount: 0,
    pinned: 0,
    decayHalfLifeDays: 90,
    lastReinforcedAt: '2026-06-01T00:00:00.000Z',
    explanation: 'test',
    sources: [],
    contradictions: [],
    userNote: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...partial,
  };
}

describe('resolvePersonalization', () => {
  it('returns sane defaults with no preferences', () => {
    const result = resolvePersonalization([], { task: 'digest' });
    expect(result.config.structure).toBe('bullets');
    expect(result.config.verbosity).toBe('balanced');
    expect(result.applied).toEqual([]);
  });

  it('applies a confident preference and explains why', () => {
    const result = resolvePersonalization([preference({})], { task: 'email_draft' });
    expect(result.config.verbosity).toBe('concise');
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.reason).toContain('inferred from 6 repeated behaviors');
  });

  it('skips low-confidence tentative preferences', () => {
    const tentative = preference({ confidence: 0.3 });
    const result = resolvePersonalization([tentative], { task: 'email_draft' });
    expect(result.config.verbosity).toBe('balanced');
    expect(result.applied).toEqual([]);
  });

  it('applies low-confidence preferences when pinned or explicit', () => {
    const pinned = preference({ confidence: 0.3, pinned: 1 });
    expect(resolvePersonalization([pinned], { task: 'email_draft' }).applied).toHaveLength(1);
    const explicit = preference({ confidence: 0.3, origin: 'explicit' });
    expect(resolvePersonalization([explicit], { task: 'email_draft' }).applied).toHaveLength(1);
  });

  it('never applies rejected or retired preferences', () => {
    expect(
      resolvePersonalization([preference({ status: 'rejected' })], { task: 'email_draft' }).applied,
    ).toEqual([]);
    expect(
      resolvePersonalization([preference({ status: 'retired' })], { task: 'email_draft' }).applied,
    ).toEqual([]);
  });

  it('the most specific matching scope wins (context-dependent behavior)', () => {
    const global = preference({ id: 'lpr_g', value: 'detailed', scope: {} });
    const leadership = preference({
      id: 'lpr_l',
      value: 'concise',
      scope: { audience: 'leadership' },
    });
    const result = resolvePersonalization([global, leadership], {
      task: 'email_draft',
      audience: 'leadership',
    });
    expect(result.config.verbosity).toBe('concise');
    expect(result.applied.map((a) => a.preferenceId)).toEqual(['lpr_g', 'lpr_l']);
  });

  it('does not apply scoped preferences outside their scope', () => {
    const leadership = preference({ value: 'concise', scope: { audience: 'leadership' } });
    const result = resolvePersonalization([leadership], {
      task: 'email_draft',
      audience: 'personal',
    });
    expect(result.applied).toEqual([]);
  });

  it('maps topic/person priorities to emphasize/deemphasize', () => {
    const topic = preference({
      id: 'lpr_t',
      key: 'topic.priority:atlas',
      value: 'high',
      category: 'topics',
    });
    const person = preference({
      id: 'lpr_p',
      key: 'person.priority:noise@vendor.io',
      value: 'low',
      category: 'people',
    });
    const { config } = resolvePersonalization([topic, person], { task: 'task_ranking' });
    expect(config.emphasize).toContain('atlas');
    expect(config.deemphasize).toContain('noise@vendor.io');
  });

  it('applies the risk-first preference (prospect theory)', () => {
    const risk = preference({
      key: 'risk.attention',
      value: 'prioritizes_risk',
      category: 'priorities',
    });
    expect(resolvePersonalization([risk], { task: 'digest' }).config.riskFirst).toBe(true);
  });

  it('tightens output when the user is busy right now (cognitive load)', () => {
    const result = resolvePersonalization([], { task: 'digest', userBusy: true });
    expect(result.config.verbosity).toBe('concise');
    expect(result.config.maxItemsPerSection).toBe(5);
  });
});
