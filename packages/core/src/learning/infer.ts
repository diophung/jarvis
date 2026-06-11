/**
 * Preference inference engine: aggregates pending learning signals into
 * learned preferences. Pure and deterministic — persistence (ids, rows,
 * audits) is the server learning service's job.
 *
 * Rules implemented here (see docs/self_learning_psychology_foundation.md):
 *  - Explicit > feedback > inferred origins.
 *  - Repeated, recency-weighted evidence raises confidence (habit formation).
 *  - Contradictory evidence in the SAME scope suppresses confidence and can
 *    flip a non-explicit preference once it clearly dominates.
 *  - Different scopes never contradict each other — that is a context split
 *    (context-dependent behavior), and is the normal case.
 *  - Preferences the user marked wrong ('rejected') are never re-learned
 *    from behavior; only a new explicit statement reactivates them.
 */
import { computeConfidence, recencyWeight } from './confidence.js';
import {
  DECAY_HALF_LIFE_DAYS,
  MAX_STORED_SOURCES,
  scopeKey,
  type LearnedPreference,
  type LearningScope,
  type LearningSignal,
  type PreferenceCategory,
  type PreferenceDraft,
  type PreferenceOrigin,
  type SignalSource,
} from './types.js';

/**
 * Minimum weighted evidence before a brand-new preference is created. A
 * single passive observation (strength ≤ 0.7) can never reach this — only an
 * explicit statement (strength 1) creates a preference on first sight.
 */
const MIN_NEW_PREFERENCE_WEIGHT = 1;
/** Dominant value must hold at least this share of a group's weight. */
const MIN_DOMINANCE_RATIO = 0.6;
/** A contradiction batch must outweigh existing support by this factor to flip a preference. */
const FLIP_RATIO = 1.5;

// ---------- Key → category / statement templates ----------

const CATEGORY_BY_PREFIX: Array<[string, PreferenceCategory]> = [
  ['style.', 'communication_style'],
  ['format.', 'format'],
  ['person.', 'people'],
  ['topic.sentiment:', 'topics'],
  ['topic.', 'topics'],
  ['risk.', 'priorities'],
  ['goal.', 'priorities'],
  ['schedule.', 'scheduling'],
  ['workflow.', 'workflow'],
  ['action.', 'decision_style'],
];

export function categoryForKey(key: string): PreferenceCategory | null {
  for (const [prefix, category] of CATEGORY_BY_PREFIX) {
    if (key.startsWith(prefix)) return category;
  }
  return null;
}

const AUDIENCE_PHRASES: Record<string, string> = {
  leadership: 'when writing to leadership',
  team: 'with the team',
  external: 'with external contacts',
  personal: 'in personal messages',
  unknown: '',
};

function scopePhrase(scope: LearningScope): string {
  const parts: string[] = [];
  if (scope.audience !== undefined && AUDIENCE_PHRASES[scope.audience] !== '') {
    parts.push(AUDIENCE_PHRASES[scope.audience] ?? '');
  }
  if (scope.channel !== undefined && scope.audience === undefined) {
    parts.push(`in ${scope.channel}`);
  }
  if (scope.domain !== undefined) parts.push(`in a ${scope.domain} context`);
  return parts.length === 0 ? '' : ` ${parts.join(', ')}`;
}

/**
 * Human-readable statement for a (key, value, scope). Statements are phrased
 * as tendencies, never identity labels (Big Five caution: soft signals only).
 * Returns null for signal families that never become preferences (e.g.
 * commitments, raw sentiment).
 */
export function statementFor(key: string, value: string, scope: LearningScope): string | null {
  const ctx = scopePhrase(scope);
  if (key === 'style.length') {
    return value === 'concise'
      ? `Tends to prefer concise messages${ctx}`
      : `Tends to prefer detailed messages${ctx}`;
  }
  if (key === 'style.directness') {
    return value === 'direct'
      ? `Tends to prefer a direct, low-hedging tone${ctx}`
      : `Tends to prefer a softened, diplomatic tone${ctx}`;
  }
  if (key === 'style.formality') {
    return `Tends to write in a ${value} register${ctx}`;
  }
  if (key === 'format.structure' && value === 'bullets') {
    return `Tends to prefer bullet-point structure${ctx}`;
  }
  if (key.startsWith('person.priority:')) {
    const email = key.slice('person.priority:'.length);
    return value === 'high'
      ? `Treats ${email} as a high-priority contact`
      : `Tends to deprioritize messages from ${email}`;
  }
  if (key.startsWith('topic.priority:')) {
    const topic = key.slice('topic.priority:'.length);
    return value === 'high'
      ? `Prioritizes items related to "${topic}"`
      : `Tends to deprioritize items related to "${topic}"`;
  }
  if (key === 'risk.attention' && value === 'prioritizes_risk') {
    return 'Tends to respond first to risk- or loss-framed items';
  }
  if (key.startsWith('goal.topic:')) {
    const topic = key.slice('goal.topic:'.length);
    return value === 'blocked'
      ? `Has a goal around "${topic}" that appears blocked`
      : `Is working toward a goal around "${topic}"`;
  }
  if (key === 'schedule.load' && value === 'overloaded') {
    return 'Frequently has a dense calendar — benefits from short, structured briefings';
  }
  if (key === 'workflow.delegation' && value === 'delegates') {
    return `Tends to delegate execution work${ctx}`;
  }
  if (key.startsWith('action.trust:')) {
    const capability = key.slice('action.trust:'.length);
    return value === 'approved'
      ? `Usually approves proposed '${capability}' actions`
      : `Usually declines proposed '${capability}' actions`;
  }
  return null; // commitment, topic.sentiment, etc.: signals only, no preference
}

// ---------- Origin resolution ----------

function originOfSignal(signal: LearningSignal): PreferenceOrigin {
  if (signal.kind === 'explicit_statement') return 'explicit';
  if (signal.kind === 'feedback' || signal.kind === 'action_decision') return 'feedback';
  return 'inferred';
}

const ORIGIN_RANK: Record<PreferenceOrigin, number> = { explicit: 2, feedback: 1, inferred: 0 };

function strongestOrigin(a: PreferenceOrigin, b: PreferenceOrigin): PreferenceOrigin {
  return ORIGIN_RANK[a] >= ORIGIN_RANK[b] ? a : b;
}

// ---------- Inference ----------

export interface InferenceInput {
  now: string;
  /** Pending (unprocessed) signals. */
  signals: LearningSignal[];
  /** All existing preferences for the user (any status). */
  existing: LearnedPreference[];
}

export interface InferenceResult {
  created: PreferenceDraft[];
  /** Full updated copies of existing preferences. */
  updated: LearnedPreference[];
  /** Signals consumed this run (to be marked processed). */
  consumedSignalIds: string[];
  /** Signal groups left pending for more evidence. */
  pendingGroups: number;
}

interface Group {
  key: string;
  scope: LearningScope;
  signals: LearningSignal[];
}

function capSources(sources: SignalSource[]): SignalSource[] {
  return sources.slice(-MAX_STORED_SOURCES);
}

function buildExplanation(opts: {
  origin: PreferenceOrigin;
  evidenceCount: number;
  contradictionCount: number;
  latestNote: string | undefined;
  flipped: boolean;
}): string {
  const parts: string[] = [];
  if (opts.origin === 'explicit') {
    parts.push('You told Donna this directly.');
  } else if (opts.origin === 'feedback') {
    parts.push(`Learned from your explicit feedback (${opts.evidenceCount} observation${opts.evidenceCount === 1 ? '' : 's'}).`);
  } else {
    parts.push(
      `Inferred from ${opts.evidenceCount} repeated observation${opts.evidenceCount === 1 ? '' : 's'} of your behavior — never from a single event.`,
    );
  }
  if (opts.latestNote !== undefined) parts.push(`Most recent evidence: ${opts.latestNote}.`);
  if (opts.contradictionCount > 0) {
    parts.push(`${opts.contradictionCount} observation${opts.contradictionCount === 1 ? '' : 's'} pointed the other way, which lowers confidence.`);
  }
  if (opts.flipped) parts.push('This preference recently flipped because newer behavior consistently pointed the other way.');
  parts.push('Correct or delete this anytime — Donna treats it as a tendency, not a fact.');
  return parts.join(' ');
}

/** Aggregate pending signals into preference creations/updates. */
export function inferPreferences(input: InferenceInput): InferenceResult {
  const { now, signals, existing } = input;
  const groups = new Map<string, Group>();
  for (const signal of signals) {
    const gk = `${signal.key} ${scopeKey(signal.scope)}`;
    const group = groups.get(gk) ?? { key: signal.key, scope: signal.scope, signals: [] };
    group.signals.push(signal);
    groups.set(gk, group);
  }

  const existingByGroup = new Map<string, LearnedPreference>();
  for (const pref of existing) {
    existingByGroup.set(`${pref.key} ${scopeKey(pref.scope)}`, pref);
  }

  const created: PreferenceDraft[] = [];
  const updated: LearnedPreference[] = [];
  const consumedSignalIds: string[] = [];
  let pendingGroups = 0;

  for (const [gk, group] of groups) {
    const firstSignal = group.signals[0];
    if (firstSignal === undefined) continue;
    const category = categoryForKey(group.key);
    const templateExists = statementFor(group.key, firstSignal.value, group.scope) !== null;
    if (category === null || !templateExists) {
      // Informational signal families (commitments, sentiment): consume
      // without forming a preference — they remain queryable provenance.
      consumedSignalIds.push(...group.signals.map((s) => s.id));
      continue;
    }

    // Weighted votes per value: strength × recency (recent behavior counts more).
    const weights = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const signal of group.signals) {
      const w = signal.strength * recencyWeight(signal.observedAt, now);
      weights.set(signal.value, (weights.get(signal.value) ?? 0) + w);
      counts.set(signal.value, (counts.get(signal.value) ?? 0) + 1);
    }
    const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked[0];
    if (top === undefined) continue;
    const [dominantValue, dominantWeight] = top;
    const totalWeight = ranked.reduce((sum, [, w]) => sum + w, 0);

    const prior = existingByGroup.get(gk);
    const batchOrigin = group.signals.reduce<PreferenceOrigin>(
      (acc, s) => strongestOrigin(acc, originOfSignal(s)),
      'inferred',
    );

    if (prior !== undefined) {
      const result = mergeIntoExisting({ prior, group, weights, counts, batchOrigin, now });
      if (result !== null) updated.push(result);
      // Consume either way: when the user rejected this preference, behavior
      // signals for it are discarded rather than re-learned (user authority).
      consumedSignalIds.push(...group.signals.map((s) => s.id));
      continue;
    }

    // New preference: require enough weight and clear dominance before
    // asserting anything (one-off actions never become preferences).
    const dominant = dominantWeight >= MIN_NEW_PREFERENCE_WEIGHT && dominantWeight / totalWeight >= MIN_DOMINANCE_RATIO;
    if (!dominant) {
      pendingGroups += 1;
      continue; // leave signals unprocessed; future evidence may settle it
    }

    const supporting = group.signals.filter((s) => s.value === dominantValue);
    const contradicting = group.signals.filter((s) => s.value !== dominantValue);
    const evidenceCount = counts.get(dominantValue) ?? supporting.length;
    const contradictionCount = contradicting.length;
    const statement = statementFor(group.key, dominantValue, group.scope);
    if (statement === null) {
      consumedSignalIds.push(...group.signals.map((s) => s.id));
      continue;
    }
    const confidence = computeConfidence({
      origin: batchOrigin,
      evidenceWeight: dominantWeight,
      contradictionCount,
    });
    const lastSupporting = supporting[supporting.length - 1];
    if (lastSupporting === undefined) continue;

    created.push({
      category,
      key: group.key,
      value: dominantValue,
      statement,
      scope: group.scope,
      origin: batchOrigin,
      status: 'active',
      confidence,
      evidenceCount,
      evidenceWeight: dominantWeight,
      contradictionCount,
      pinned: 0,
      decayHalfLifeDays: DECAY_HALF_LIFE_DAYS[batchOrigin],
      lastReinforcedAt: lastSupporting.observedAt,
      explanation: buildExplanation({
        origin: batchOrigin,
        evidenceCount,
        contradictionCount,
        latestNote: lastSupporting.detail ?? undefined,
        flipped: false,
      }),
      sources: capSources(supporting.map((s) => s.source)),
      contradictions: capSources(contradicting.map((s) => s.source)),
      userNote: null,
    });
    consumedSignalIds.push(...group.signals.map((s) => s.id));
  }

  return { created, updated, consumedSignalIds, pendingGroups };
}

function mergeIntoExisting(opts: {
  prior: LearnedPreference;
  group: Group;
  weights: Map<string, number>;
  counts: Map<string, number>;
  batchOrigin: PreferenceOrigin;
  now: string;
}): LearnedPreference | null {
  const { prior, group, weights, counts, batchOrigin, now } = opts;

  const supportWeight = weights.get(prior.value) ?? 0;
  const supportCount = counts.get(prior.value) ?? 0;
  const opposing = [...weights.entries()]
    .filter(([v]) => v !== prior.value)
    .sort((a, b) => b[1] - a[1]);
  const opposingWeight = opposing.reduce((sum, [, w]) => sum + w, 0);
  const opposingCount = group.signals.length - supportCount;
  const hasExplicit = batchOrigin === 'explicit';
  const explicitValue = hasExplicit
    ? group.signals.filter((s) => originOfSignal(s) === 'explicit').slice(-1)[0]?.value
    : undefined;

  // Rejected preferences are never re-learned from behavior; only a fresh
  // explicit statement (user changed their mind) reactivates the group.
  if (prior.status === 'rejected' && !hasExplicit) return null;

  const supporting = group.signals.filter((s) => s.value === prior.value);
  const contradicting = group.signals.filter((s) => s.value !== prior.value);

  let next: LearnedPreference = { ...prior };

  // An explicit statement overrides everything (explicit > behavior).
  if (explicitValue !== undefined) {
    const flipped = explicitValue !== prior.value;
    const statement = statementFor(prior.key, explicitValue, prior.scope);
    if (statement === null) return null;
    const explicitSignals = group.signals.filter(
      (s) => originOfSignal(s) === 'explicit' && s.value === explicitValue,
    );
    const weight = flipped
      ? explicitSignals.reduce((sum, s) => sum + s.strength, 0)
      : prior.evidenceWeight + supportWeight;
    next = {
      ...next,
      value: explicitValue,
      statement,
      origin: 'explicit',
      status: 'active',
      evidenceCount: flipped ? explicitSignals.length : prior.evidenceCount + supportCount,
      evidenceWeight: weight,
      contradictionCount: flipped ? 0 : prior.contradictionCount,
      decayHalfLifeDays: DECAY_HALF_LIFE_DAYS.explicit,
      lastReinforcedAt: now,
      sources: capSources([...(flipped ? [] : prior.sources), ...explicitSignals.map((s) => s.source)]),
      contradictions: flipped ? [] : prior.contradictions,
      updatedAt: now,
    };
    next.confidence = computeConfidence({
      origin: 'explicit',
      evidenceWeight: next.evidenceWeight,
      contradictionCount: next.contradictionCount,
    });
    next.explanation = buildExplanation({
      origin: 'explicit',
      evidenceCount: next.evidenceCount,
      contradictionCount: next.contradictionCount,
      latestNote: explicitSignals[explicitSignals.length - 1]?.detail ?? undefined,
      flipped,
    });
    return next;
  }

  // Contradiction flip: behavior may flip a NON-explicit, non-pinned
  // preference once opposing evidence clearly dominates accumulated support.
  const canFlip = prior.origin !== 'explicit' && prior.pinned !== 1;
  const topOpposing = opposing[0];
  if (
    canFlip &&
    topOpposing !== undefined &&
    opposingWeight >= FLIP_RATIO * (prior.evidenceWeight + supportWeight)
  ) {
    const [newValue, newWeight] = topOpposing;
    const statement = statementFor(prior.key, newValue, prior.scope);
    if (statement !== null) {
      const flipSupport = group.signals.filter((s) => s.value === newValue);
      next = {
        ...next,
        value: newValue,
        statement,
        origin: batchOrigin,
        status: 'active',
        evidenceCount: flipSupport.length,
        evidenceWeight: newWeight,
        contradictionCount: prior.evidenceCount,
        decayHalfLifeDays: DECAY_HALF_LIFE_DAYS[batchOrigin],
        lastReinforcedAt: now,
        sources: capSources(flipSupport.map((s) => s.source)),
        contradictions: capSources([...prior.sources]),
        updatedAt: now,
      };
      next.confidence = computeConfidence({
        origin: next.origin,
        evidenceWeight: next.evidenceWeight,
        contradictionCount: next.contradictionCount,
      });
      next.explanation = buildExplanation({
        origin: next.origin,
        evidenceCount: next.evidenceCount,
        contradictionCount: next.contradictionCount,
        latestNote: flipSupport[flipSupport.length - 1]?.detail ?? undefined,
        flipped: true,
      });
      return next;
    }
  }

  // Normal reinforcement: support adds evidence, opposition adds contradictions.
  next = {
    ...next,
    origin: strongestOrigin(prior.origin, batchOrigin),
    status: prior.status === 'retired' && supportCount > 0 ? 'active' : prior.status,
    evidenceCount: prior.evidenceCount + supportCount,
    evidenceWeight: prior.evidenceWeight + supportWeight,
    contradictionCount: prior.contradictionCount + opposingCount,
    lastReinforcedAt: supportCount > 0 ? now : prior.lastReinforcedAt,
    sources: capSources([...prior.sources, ...supporting.map((s) => s.source)]),
    contradictions: capSources([...prior.contradictions, ...contradicting.map((s) => s.source)]),
    updatedAt: now,
  };
  next.decayHalfLifeDays = DECAY_HALF_LIFE_DAYS[next.origin];
  next.confidence = computeConfidence({
    origin: next.origin,
    evidenceWeight: next.evidenceWeight,
    contradictionCount: next.contradictionCount,
  });
  const latest = supporting[supporting.length - 1] ?? contradicting[contradicting.length - 1];
  next.explanation = buildExplanation({
    origin: next.origin,
    evidenceCount: next.evidenceCount,
    contradictionCount: next.contradictionCount,
    latestNote: latest?.detail ?? undefined,
    flipped: false,
  });
  return next;
}

// ---------- Contradiction reporting & merging ----------

export interface ContradictionReportEntry {
  kind: 'internal' | 'context_split';
  preferenceIds: string[];
  description: string;
}

/**
 * Report contradictions for the user: internal (mixed evidence within one
 * scope) and context splits (same key, different value in different scopes —
 * usually legitimate context-dependent behavior, surfaced for transparency).
 */
export function contradictionReport(prefs: LearnedPreference[]): ContradictionReportEntry[] {
  const entries: ContradictionReportEntry[] = [];
  const active = prefs.filter((p) => p.status === 'active');
  for (const pref of active) {
    if (pref.contradictionCount >= 2) {
      entries.push({
        kind: 'internal',
        preferenceIds: [pref.id],
        description: `"${pref.statement}" has ${pref.contradictionCount} contradicting observations in the same context.`,
      });
    }
  }
  const byKey = new Map<string, LearnedPreference[]>();
  for (const pref of active) {
    const list = byKey.get(pref.key) ?? [];
    list.push(pref);
    byKey.set(pref.key, list);
  }
  for (const list of byKey.values()) {
    const first = list[0];
    if (first === undefined || list.length < 2) continue;
    const values = new Set(list.map((p) => p.value));
    if (values.size < 2) continue;
    entries.push({
      kind: 'context_split',
      preferenceIds: list.map((p) => p.id),
      description: `Behavior differs by context for "${first.key}" — Donna keeps separate preferences per context instead of averaging them.`,
    });
  }
  return entries;
}

export interface MergeResult {
  /** Surviving preferences with merged evidence (updated copies). */
  merged: LearnedPreference[];
  /** Ids of preferences absorbed into a survivor. */
  absorbedIds: string[];
}

function scopeIsSubset(narrow: LearningScope, broad: LearningScope): boolean {
  const broadEntries = Object.entries(broad).filter(([, v]) => v !== undefined);
  return broadEntries.every(([k, v]) => narrow[k as keyof LearningScope] === v);
}

/**
 * Merge duplicate preferences: same key + value where one scope generalizes
 * the other. The broader preference absorbs the narrower one's evidence.
 */
export function mergeSimilarPreferences(prefs: LearnedPreference[], now: string): MergeResult {
  const merged: LearnedPreference[] = [];
  const absorbedIds: string[] = [];
  const active = prefs.filter((p) => p.status === 'active');

  for (const broad of active) {
    if (absorbedIds.includes(broad.id)) continue;
    let acc: LearnedPreference | null = null;
    for (const narrow of active) {
      if (narrow.id === broad.id || absorbedIds.includes(narrow.id)) continue;
      if (narrow.key !== broad.key || narrow.value !== broad.value) continue;
      if (scopeKey(narrow.scope) === scopeKey(broad.scope)) continue;
      if (!scopeIsSubset(narrow.scope, broad.scope)) continue;
      const base: LearnedPreference = acc ?? broad;
      acc = {
        ...base,
        evidenceCount: base.evidenceCount + narrow.evidenceCount,
        evidenceWeight: base.evidenceWeight + narrow.evidenceWeight,
        contradictionCount: base.contradictionCount + narrow.contradictionCount,
        pinned: base.pinned === 1 || narrow.pinned === 1 ? 1 : 0,
        origin: strongestOrigin(base.origin, narrow.origin),
        lastReinforcedAt:
          base.lastReinforcedAt > narrow.lastReinforcedAt
            ? base.lastReinforcedAt
            : narrow.lastReinforcedAt,
        sources: capSources([...base.sources, ...narrow.sources]),
        contradictions: capSources([...base.contradictions, ...narrow.contradictions]),
        updatedAt: now,
      };
      absorbedIds.push(narrow.id);
    }
    if (acc !== null) {
      acc.decayHalfLifeDays = DECAY_HALF_LIFE_DAYS[acc.origin];
      acc.confidence = computeConfidence({
        origin: acc.origin,
        evidenceWeight: acc.evidenceWeight,
        contradictionCount: acc.contradictionCount,
      });
      merged.push(acc);
    }
  }
  return { merged, absorbedIds };
}
