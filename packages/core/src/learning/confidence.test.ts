import { describe, expect, it } from 'vitest';
import {
  computeConfidence,
  CONFIDENCE_FLOOR,
  decayConfidence,
  evidenceFactor,
  ORIGIN_BASE_CONFIDENCE,
  ORIGIN_MAX_CONFIDENCE,
  recencyWeight,
} from './confidence.js';

describe('evidenceFactor', () => {
  it('contributes nothing for a single observation (repetition required)', () => {
    expect(evidenceFactor(0)).toBe(0);
    expect(evidenceFactor(0.7)).toBe(0);
    expect(evidenceFactor(1)).toBe(0);
  });

  it('grows monotonically and saturates below 1', () => {
    let prev = 0;
    for (const w of [2, 4, 8, 16, 32]) {
      const f = evidenceFactor(w);
      expect(f).toBeGreaterThan(prev);
      expect(f).toBeLessThan(1);
      prev = f;
    }
    expect(evidenceFactor(32)).toBeGreaterThan(0.95);
  });
});

describe('computeConfidence', () => {
  it('a single inferred observation stays at the low origin base', () => {
    const c = computeConfidence({ origin: 'inferred', evidenceWeight: 0.5, contradictionCount: 0 });
    expect(c).toBe(ORIGIN_BASE_CONFIDENCE.inferred);
    expect(c).toBeLessThan(0.45); // below the actionable threshold
  });

  it('explicit statements start high and can reach 1', () => {
    expect(
      computeConfidence({ origin: 'explicit', evidenceWeight: 1, contradictionCount: 0 }),
    ).toBe(ORIGIN_BASE_CONFIDENCE.explicit);
    expect(
      computeConfidence({ origin: 'explicit', evidenceWeight: 40, contradictionCount: 0 }),
    ).toBeGreaterThan(0.99);
  });

  it('ranks explicit > feedback > inferred at equal evidence', () => {
    const at = (origin: 'explicit' | 'feedback' | 'inferred') =>
      computeConfidence({ origin, evidenceWeight: 3, contradictionCount: 0 });
    expect(at('explicit')).toBeGreaterThan(at('feedback'));
    expect(at('feedback')).toBeGreaterThan(at('inferred'));
  });

  it('inferred confidence never reaches certainty', () => {
    const c = computeConfidence({ origin: 'inferred', evidenceWeight: 1000, contradictionCount: 0 });
    expect(c).toBeLessThanOrEqual(ORIGIN_MAX_CONFIDENCE.inferred);
  });

  it('repeated evidence raises confidence', () => {
    const one = computeConfidence({ origin: 'inferred', evidenceWeight: 1, contradictionCount: 0 });
    const many = computeConfidence({ origin: 'inferred', evidenceWeight: 6, contradictionCount: 0 });
    expect(many).toBeGreaterThan(one);
  });

  it('contradictions suppress confidence', () => {
    const clean = computeConfidence({ origin: 'inferred', evidenceWeight: 6, contradictionCount: 0 });
    const contested = computeConfidence({
      origin: 'inferred',
      evidenceWeight: 6,
      contradictionCount: 3,
    });
    expect(contested).toBeLessThan(clean);
  });
});

describe('decayConfidence', () => {
  const now = '2026-06-11T00:00:00.000Z';

  it('does not decay a freshly reinforced preference', () => {
    expect(
      decayConfidence({
        confidence: 0.7,
        lastReinforcedAt: now,
        now,
        decayHalfLifeDays: 90,
        pinned: false,
      }),
    ).toBe(0.7);
  });

  it('halves confidence after one half-life', () => {
    const decayed = decayConfidence({
      confidence: 0.8,
      lastReinforcedAt: '2026-03-13T00:00:00.000Z', // 90 days earlier
      now,
      decayHalfLifeDays: 90,
      pinned: false,
    });
    expect(decayed).toBeCloseTo(0.4, 2);
  });

  it('never decays below the floor', () => {
    const decayed = decayConfidence({
      confidence: 0.8,
      lastReinforcedAt: '2016-06-11T00:00:00.000Z',
      now,
      decayHalfLifeDays: 30,
      pinned: false,
    });
    expect(decayed).toBe(CONFIDENCE_FLOOR);
  });

  it('pinned preferences are exempt from decay', () => {
    const decayed = decayConfidence({
      confidence: 0.8,
      lastReinforcedAt: '2020-01-01T00:00:00.000Z',
      now,
      decayHalfLifeDays: 30,
      pinned: true,
    });
    expect(decayed).toBe(0.8);
  });
});

describe('recencyWeight', () => {
  const now = '2026-06-11T00:00:00.000Z';

  it('counts the last week fully', () => {
    expect(recencyWeight('2026-06-10T00:00:00.000Z', now)).toBe(1);
    expect(recencyWeight(now, now)).toBe(1);
  });

  it('fades older observations toward zero', () => {
    const month = recencyWeight('2026-05-11T00:00:00.000Z', now);
    const halfYear = recencyWeight('2025-12-11T00:00:00.000Z', now);
    expect(month).toBeLessThan(1);
    expect(halfYear).toBeLessThan(month);
    expect(halfYear).toBeGreaterThanOrEqual(0);
  });
});
