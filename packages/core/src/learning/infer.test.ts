import { describe, expect, it } from 'vitest';
import {
  contradictionReport,
  inferPreferences,
  mergeSimilarPreferences,
  statementFor,
} from './infer.js';
import { MIN_ACTIONABLE_CONFIDENCE, type LearnedPreference, type LearningSignal } from './types.js';

const NOW = '2026-06-11T12:00:00.000Z';

let seq = 0;
function signal(partial: Partial<LearningSignal>): LearningSignal {
  seq += 1;
  return {
    id: `sig_${seq}`,
    workspaceId: 'wsp_1',
    userId: 'usr_1',
    kind: 'writing_style',
    key: 'style.length',
    value: 'concise',
    strength: 0.5,
    scope: { audience: 'leadership' },
    detail: 'Wrote a concise message to leadership',
    source: { sourceType: 'source_item', refId: `itm_${seq}`, observedAt: NOW },
    observedAt: '2026-06-10T09:00:00.000Z',
    processed: 0,
    createdAt: NOW,
    ...partial,
  };
}

function preference(partial: Partial<LearnedPreference>): LearnedPreference {
  return {
    id: 'lpr_1',
    workspaceId: 'wsp_1',
    userId: 'usr_1',
    category: 'communication_style',
    key: 'style.length',
    value: 'concise',
    statement: 'Tends to prefer concise messages when writing to leadership',
    scope: { audience: 'leadership' },
    origin: 'inferred',
    status: 'active',
    confidence: 0.5,
    evidenceCount: 4,
    evidenceWeight: 2,
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

describe('inferPreferences — creation', () => {
  it('does not create a preference from a single weak observation', () => {
    const result = inferPreferences({ now: NOW, signals: [signal({})], existing: [] });
    expect(result.created).toEqual([]);
    expect(result.pendingGroups).toBe(1);
    expect(result.consumedSignalIds).toEqual([]);
  });

  it('creates a tentative preference from repeated consistent behavior', () => {
    const signals = [signal({}), signal({}), signal({}), signal({})];
    const result = inferPreferences({ now: NOW, signals, existing: [] });
    expect(result.created).toHaveLength(1);
    const pref = result.created[0]!;
    expect(pref.key).toBe('style.length');
    expect(pref.value).toBe('concise');
    expect(pref.origin).toBe('inferred');
    expect(pref.evidenceCount).toBe(4);
    expect(pref.statement).toContain('concise');
    expect(pref.statement).toContain('leadership');
    expect(pref.explanation).toContain('repeated observation');
    expect(result.consumedSignalIds).toHaveLength(4);
  });

  it('refuses to create a preference from evenly contradictory evidence', () => {
    const signals = [
      signal({ value: 'concise' }),
      signal({ value: 'detailed' }),
      signal({ value: 'concise' }),
      signal({ value: 'detailed' }),
    ];
    const result = inferPreferences({ now: NOW, signals, existing: [] });
    expect(result.created).toEqual([]);
    expect(result.pendingGroups).toBe(1);
  });

  it('keeps different scopes as separate preferences (context split, not contradiction)', () => {
    const leadership = [signal({}), signal({}), signal({})];
    const personal = [
      signal({ value: 'detailed', scope: { audience: 'personal' } }),
      signal({ value: 'detailed', scope: { audience: 'personal' } }),
      signal({ value: 'detailed', scope: { audience: 'personal' } }),
    ];
    const result = inferPreferences({
      now: NOW,
      signals: [...leadership, ...personal],
      existing: [],
    });
    expect(result.created).toHaveLength(2);
    const values = result.created.map((p) => `${p.scope.audience}:${p.value}`).sort();
    expect(values).toEqual(['leadership:concise', 'personal:detailed']);
  });

  it('a single explicit statement immediately creates a high-confidence preference', () => {
    const explicit = signal({
      kind: 'explicit_statement',
      strength: 1,
      scope: {},
      detail: 'Asked for concise output',
    });
    const result = inferPreferences({ now: NOW, signals: [explicit], existing: [] });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.origin).toBe('explicit');
    expect(result.created[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('consumes informational signals (commitments, sentiment) without creating preferences', () => {
    const commitment = signal({ kind: 'commitment', key: 'commitment', value: 'made', scope: {} });
    const sentiment = signal({
      kind: 'sentiment',
      key: 'topic.sentiment:atlas',
      value: 'negative',
      scope: {},
    });
    const result = inferPreferences({ now: NOW, signals: [commitment, sentiment], existing: [] });
    expect(result.created).toEqual([]);
    expect(result.consumedSignalIds).toHaveLength(2);
    expect(result.pendingGroups).toBe(0);
  });
});

describe('inferPreferences — reinforcement & contradiction', () => {
  it('reinforces an existing preference and raises confidence', () => {
    // Prior confidence consistent with its evidence weight (computeConfidence(inferred, 2, 0)).
    const prior = preference({ confidence: 0.37 });
    const result = inferPreferences({
      now: NOW,
      signals: [signal({}), signal({})],
      existing: [prior],
    });
    expect(result.updated).toHaveLength(1);
    const updated = result.updated[0]!;
    expect(updated.evidenceCount).toBe(6);
    expect(updated.confidence).toBeGreaterThan(prior.confidence);
    expect(updated.lastReinforcedAt).toBe(NOW);
  });

  it('counts opposing evidence as contradictions that lower confidence', () => {
    const prior = preference({ evidenceWeight: 4, confidence: 0.6 });
    const result = inferPreferences({
      now: NOW,
      signals: [signal({ value: 'detailed' })],
      existing: [prior],
    });
    const updated = result.updated[0]!;
    expect(updated.value).toBe('concise'); // not flipped by one observation
    expect(updated.contradictionCount).toBe(1);
    expect(updated.confidence).toBeLessThan(prior.confidence);
    expect(updated.contradictions).toHaveLength(1);
  });

  it('flips a non-explicit preference when opposing behavior clearly dominates', () => {
    const prior = preference({ evidenceWeight: 1, evidenceCount: 2 });
    const opposing = Array.from({ length: 8 }, () => signal({ value: 'detailed', strength: 0.7 }));
    const result = inferPreferences({ now: NOW, signals: opposing, existing: [prior] });
    const updated = result.updated[0]!;
    expect(updated.value).toBe('detailed');
    expect(updated.statement).toContain('detailed');
    expect(updated.explanation).toContain('flipped');
  });

  it('never flips an explicit preference from behavior alone', () => {
    const prior = preference({ origin: 'explicit', confidence: 0.9, evidenceWeight: 1 });
    const opposing = Array.from({ length: 10 }, () => signal({ value: 'detailed', strength: 0.7 }));
    const result = inferPreferences({ now: NOW, signals: opposing, existing: [prior] });
    expect(result.updated[0]!.value).toBe('concise');
    expect(result.updated[0]!.contradictionCount).toBeGreaterThan(0);
  });

  it('an explicit statement overrides accumulated behavior (explicit > inferred)', () => {
    const prior = preference({ evidenceWeight: 10, evidenceCount: 20, confidence: 0.75 });
    const explicit = signal({
      kind: 'explicit_statement',
      value: 'detailed',
      strength: 1,
      detail: 'Asked for more detailed output',
    });
    const result = inferPreferences({ now: NOW, signals: [explicit], existing: [prior] });
    const updated = result.updated[0]!;
    expect(updated.value).toBe('detailed');
    expect(updated.origin).toBe('explicit');
    expect(updated.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('never re-learns a preference the user marked wrong from behavior', () => {
    const rejected = preference({ status: 'rejected' });
    const result = inferPreferences({
      now: NOW,
      signals: [signal({}), signal({}), signal({})],
      existing: [rejected],
    });
    expect(result.updated).toEqual([]);
    expect(result.consumedSignalIds).toHaveLength(3); // discarded, not retried forever
  });

  it('a fresh explicit statement reactivates a rejected preference (user changed their mind)', () => {
    const rejected = preference({ status: 'rejected' });
    const explicit = signal({ kind: 'explicit_statement', strength: 1 });
    const result = inferPreferences({ now: NOW, signals: [explicit], existing: [rejected] });
    expect(result.updated[0]?.status).toBe('active');
    expect(result.updated[0]?.origin).toBe('explicit');
  });
});

describe('statementFor', () => {
  it('phrases statements as tendencies, never identity labels', () => {
    expect(statementFor('style.directness', 'direct', {})).toMatch(/^Tends to/);
    expect(statementFor('person.priority:a@b.com', 'high', {})).toContain('a@b.com');
    expect(statementFor('commitment', 'made', {})).toBeNull();
  });
});

describe('contradictionReport', () => {
  it('reports internal contradictions and context splits', () => {
    const contested = preference({ id: 'lpr_a', contradictionCount: 3 });
    const split1 = preference({ id: 'lpr_b', key: 'style.formality', value: 'formal', scope: { audience: 'external' } });
    const split2 = preference({ id: 'lpr_c', key: 'style.formality', value: 'casual', scope: { audience: 'team' } });
    const report = contradictionReport([contested, split1, split2]);
    expect(report.some((e) => e.kind === 'internal' && e.preferenceIds.includes('lpr_a'))).toBe(true);
    expect(report.some((e) => e.kind === 'context_split')).toBe(true);
  });
});

describe('mergeSimilarPreferences', () => {
  it('absorbs a narrower-scope duplicate into the broader preference', () => {
    const broad = preference({ id: 'lpr_broad', scope: { audience: 'leadership' } });
    const narrow = preference({
      id: 'lpr_narrow',
      scope: { audience: 'leadership', channel: 'email' },
      evidenceCount: 3,
      evidenceWeight: 1.5,
    });
    const result = mergeSimilarPreferences([broad, narrow], NOW);
    expect(result.absorbedIds).toEqual(['lpr_narrow']);
    expect(result.merged[0]!.id).toBe('lpr_broad');
    expect(result.merged[0]!.evidenceCount).toBe(7);
  });

  it('does not merge different values or unrelated scopes', () => {
    const a = preference({ id: 'lpr_a', value: 'concise', scope: { audience: 'leadership' } });
    const b = preference({ id: 'lpr_b', value: 'detailed', scope: { audience: 'personal' } });
    expect(mergeSimilarPreferences([a, b], NOW).absorbedIds).toEqual([]);
  });
});

describe('actionable threshold', () => {
  it('newly inferred preferences from few observations stay below the actionable bar', () => {
    const signals = [signal({ strength: 0.3 }), signal({ strength: 0.3 })];
    const result = inferPreferences({ now: NOW, signals, existing: [] });
    expect(result.created[0]?.confidence ?? 0).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
  });
});
