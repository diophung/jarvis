/**
 * Confidence scoring and decay for learned preferences. Pure math, no clock:
 * callers pass `now`.
 *
 * Principles (docs/self_learning_psychology_foundation.md):
 *  - Explicit > feedback > inferred (revealed-preference theory reconciled
 *    with stated preference: the user's direct word is authoritative).
 *  - Confidence grows only with repeated evidence (habit formation /
 *    behavioral consistency: stable preference inference must rest on
 *    repeated revealed behavior, not isolated statements).
 *  - Contradictory evidence in the same scope suppresses confidence.
 *  - Unreinforced preferences decay (preference drift / habit extinction).
 */
import type { PreferenceOrigin } from './types.js';

const DAY_MS = 86_400_000;

/** Base confidence contributed by the origin of a preference. */
export const ORIGIN_BASE_CONFIDENCE: Record<PreferenceOrigin, number> = {
  explicit: 0.9,
  feedback: 0.6,
  inferred: 0.25,
};

/** Ceiling confidence reachable through evidence accumulation, by origin. */
export const ORIGIN_MAX_CONFIDENCE: Record<PreferenceOrigin, number> = {
  explicit: 1,
  feedback: 0.9,
  inferred: 0.8, // inferred tendencies stay below certainty by design
};

/** Evidence counts at which the saturating curve reaches ~63% of its range. */
const EVIDENCE_SATURATION_K = 4;

/** Each same-scope contradiction shaves confidence multiplicatively. */
const CONTRADICTION_PENALTY = 0.3;

/** Confidence never decays below this; retirement is handled separately. */
export const CONFIDENCE_FLOOR = 0.05;

/** Below this, an unpinned preference is retired by the decay job. */
export const RETIREMENT_THRESHOLD = 0.12;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Saturating evidence curve in [0, 1) over strength-weighted evidence mass:
 * the first observations move confidence the most, then returns diminish.
 * A single observation contributes nothing beyond the origin base — this
 * confidence score increases only after repeated behavior, because stable
 * preference inference should rest on repeated revealed behavior, not
 * isolated statements (habit formation / behavioral consistency).
 */
export function evidenceFactor(evidenceWeight: number): number {
  if (evidenceWeight <= 1) return 0;
  return 1 - Math.exp(-(evidenceWeight - 1) / EVIDENCE_SATURATION_K);
}

export interface ConfidenceInput {
  origin: PreferenceOrigin;
  /** Strength- and recency-weighted evidence mass (see recencyWeight). */
  evidenceWeight: number;
  /** Contradicting observations within the SAME scope (cross-scope variation is a split, not a contradiction). */
  contradictionCount: number;
}

/**
 * Reinforcement-time confidence: base(origin) + growth toward the origin
 * ceiling with repeated evidence, suppressed by same-scope contradictions.
 */
export function computeConfidence(input: ConfidenceInput): number {
  const base = ORIGIN_BASE_CONFIDENCE[input.origin];
  const max = ORIGIN_MAX_CONFIDENCE[input.origin];
  const grown = base + (max - base) * evidenceFactor(input.evidenceWeight);
  // This penalty exists because contradictory behavior in the same context
  // means the "preference" may not be stable at all (behavioral consistency).
  const penalized = grown / (1 + CONTRADICTION_PENALTY * input.contradictionCount);
  return clamp01(Math.max(CONFIDENCE_FLOOR, penalized));
}

export interface DecayInput {
  confidence: number;
  lastReinforcedAt: string;
  now: string;
  decayHalfLifeDays: number;
  pinned: boolean;
}

/**
 * Exponential decay since last reinforcement. Pinned preferences are exempt
 * (the user vouched for them). Decay models that an unreinforced inference
 * gets less trustworthy over time, not that the user "lost" the preference.
 */
export function decayConfidence(input: DecayInput): number {
  if (input.pinned) return input.confidence;
  const elapsedMs = Date.parse(input.now) - Date.parse(input.lastReinforcedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return input.confidence;
  const halfLives = elapsedMs / (input.decayHalfLifeDays * DAY_MS);
  const decayed = input.confidence * Math.pow(0.5, halfLives);
  return clamp01(Math.max(CONFIDENCE_FLOOR, decayed));
}

/**
 * Recency weight for an observation: evidence from the last week counts
 * fully, then fades over ~90 days (recent behavior matters more than old
 * behavior). Used when (re)building evidence tallies from signals.
 */
export function recencyWeight(observedAt: string, now: string): number {
  const ageMs = Date.parse(now) - Date.parse(observedAt);
  if (!Number.isFinite(ageMs) || ageMs <= 7 * DAY_MS) return 1;
  const ageDays = ageMs / DAY_MS;
  return clamp01(Math.exp(-(ageDays - 7) / 90));
}
