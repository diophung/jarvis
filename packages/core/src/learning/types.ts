/**
 * Self-learning contracts: normalized learning signals, learned preferences,
 * and personalization shapes.
 *
 * Design rules (see docs/self_learning_psychology_foundation.md):
 *  - Signals are observations; preferences are aggregations of repeated
 *    observations (habit-formation research: repetition, not one-offs).
 *  - Everything carries provenance and a scope (context-dependent behavior:
 *    no global preference is assumed from one context).
 *  - Inferences are tentative behavioral tendencies, never identity labels.
 */
import type { SourceCategory } from '../enums.js';

// ---------- Scope (context-dependent behavior) ----------

export const LEARNING_DOMAINS = ['work', 'personal', 'finance', 'health', 'other'] as const;
export type LearningDomain = (typeof LEARNING_DOMAINS)[number];

/**
 * Audience buckets for communication preferences (politeness theory /
 * communication accommodation: register legitimately varies by audience,
 * so style is never learned globally).
 */
export const AUDIENCE_KINDS = [
  'leadership',
  'team',
  'external',
  'personal',
  'unknown',
] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/** Where a preference applies. Empty scope = global (requires broad evidence). */
export interface LearningScope {
  domain?: LearningDomain;
  audience?: AudienceKind;
  channel?: SourceCategory;
  projectId?: string;
  /** Lowercased email when the preference is about one person. */
  personEmail?: string;
}

/** Canonical, stable serialization of a scope (sorted keys) for grouping/uniqueness. */
export function scopeKey(scope: LearningScope): string {
  const entries = Object.entries(scope)
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? 'global' : entries.map(([k, v]) => `${k}=${String(v)}`).join('|');
}

// ---------- Signals ----------

export const LEARNING_SIGNAL_KINDS = [
  'writing_style', // style markers from user-authored text or draft edits
  'reply_behavior', // replied fast / replied / ignored (revealed preference)
  'topic_engagement', // repeated attention to a topic
  'person_engagement', // attention given to a person
  'feedback', // explicit item feedback (important / not important / ...)
  'explicit_statement', // "always", "never", "remember that", preference commands
  'action_decision', // approved / denied / edited an agent action
  'goal', // explicit or recurring goal
  'commitment', // a promise the user made ("I'll send X by Friday")
  'deadline', // deadline the user reacted to
  'loss_frame', // risk/loss-framed content the user engaged with (prospect theory)
  'sentiment', // coarse valence/urgency markers (affective computing, low strength)
  'calendar_density', // overload context signal (cognitive load theory)
  'delegation', // delegation / escalation pattern
] as const;
export type LearningSignalKind = (typeof LEARNING_SIGNAL_KINDS)[number];

export const SIGNAL_SOURCE_TYPES = [
  'source_item',
  'item_feedback',
  'agent_action',
  'draft_edit',
  'chat_message',
  'uploaded_file',
  'user_command',
] as const;
export type SignalSourceType = (typeof SIGNAL_SOURCE_TYPES)[number];

/** Provenance reference attached to signals and preference evidence. */
export interface SignalSource {
  sourceType: SignalSourceType;
  refId?: string;
  observedAt: string;
  /** Short human-readable observation, e.g. "Replied within 30 min to a churn-risk email". */
  note?: string;
}

/**
 * One normalized learning observation. Signals are append-only raw evidence;
 * the inference engine aggregates them into preferences.
 */
export interface LearningSignal {
  id: string;
  workspaceId: string;
  userId: string;
  kind: LearningSignalKind;
  /**
   * Aggregation key (without scope), e.g. `style.length`, `topic.priority:atlas`,
   * `person.priority:jane@acme.com`. Signals sharing key + scope feed one preference.
   */
  key: string;
  /** Observed value bucket, e.g. 'concise', 'high', 'fast_reply', 'approved'. */
  value: string;
  /**
   * 0..1 weight of this single observation. Affect/sentiment signals are
   * capped low (affective computing: never overclaim emotional certainty).
   */
  strength: number;
  scope: LearningScope;
  detail: string | null;
  source: SignalSource;
  observedAt: string;
  processed: number; // 0|1
  createdAt: string;
}

export type LearningSignalInput = Omit<
  LearningSignal,
  'id' | 'workspaceId' | 'userId' | 'processed' | 'createdAt'
>;

// ---------- Preferences ----------

export const PREFERENCE_CATEGORIES = [
  'communication_style',
  'format',
  'people',
  'topics',
  'priorities',
  'scheduling',
  'decision_style',
  'workflow',
] as const;
export type PreferenceCategory = (typeof PREFERENCE_CATEGORIES)[number];

/** explicit = user said so; feedback = direct UI feedback; inferred = repeated behavior. */
export const PREFERENCE_ORIGINS = ['explicit', 'feedback', 'inferred'] as const;
export type PreferenceOrigin = (typeof PREFERENCE_ORIGINS)[number];

export const PREFERENCE_STATUSES = [
  'active',
  /** User marked this wrong; kept (disabled) so it is not re-learned silently. */
  'rejected',
  /** Confidence decayed below the floor without reinforcement. */
  'retired',
] as const;
export type PreferenceStatus = (typeof PREFERENCE_STATUSES)[number];

/**
 * A learned preference: an inspectable, correctable, decaying aggregation of
 * evidence. The statement is always phrased as a tendency, never an identity.
 */
export interface LearnedPreference {
  id: string;
  workspaceId: string;
  userId: string;
  category: PreferenceCategory;
  /** Aggregation key matching the signals that feed it (see LearningSignal.key). */
  key: string;
  /** The dominant observed value this preference asserts (e.g. 'concise'). */
  value: string;
  /** Human-readable preference statement shown to the user. */
  statement: string;
  scope: LearningScope;
  origin: PreferenceOrigin;
  status: PreferenceStatus;
  confidence: number; // 0..1
  /** Number of supporting observations (user-facing). */
  evidenceCount: number;
  /** Strength- and recency-weighted evidence mass (drives confidence growth). */
  evidenceWeight: number;
  contradictionCount: number;
  pinned: number; // 0|1 — pinned preferences do not decay
  decayHalfLifeDays: number;
  lastReinforcedAt: string;
  /** "Why Jarvis thinks this" — mandatory explainability. */
  explanation: string;
  /** Capped list of supporting evidence references. */
  sources: SignalSource[];
  /** Capped list of contradicting evidence references. */
  contradictions: SignalSource[];
  /** Optional note the user attached when correcting/confirming. */
  userNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A preference produced by inference before persistence assigns identity. */
export type PreferenceDraft = Omit<
  LearnedPreference,
  'id' | 'workspaceId' | 'userId' | 'createdAt' | 'updatedAt'
>;

/**
 * Minimum confidence before a preference influences Jarvis's behavior.
 * Below this it is shown to the user as "tentative" but never acted on
 * (habit research: one-off behavior is a poor predictor).
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.45;

/** Evidence/contradiction reference lists are capped to keep rows bounded. */
export const MAX_STORED_SOURCES = 20;

/** Default decay half-lives by origin (explicit statements are durable). */
export const DECAY_HALF_LIFE_DAYS: Record<PreferenceOrigin, number> = {
  explicit: 365,
  feedback: 180,
  inferred: 90,
};

// ---------- Personalization ----------

export const PERSONALIZATION_TASKS = [
  'digest',
  'email_draft',
  'chat_reply',
  'summarization',
  'task_ranking',
] as const;
export type PersonalizationTask = (typeof PERSONALIZATION_TASKS)[number];

export interface PersonalizationRequest {
  task: PersonalizationTask;
  audience?: AudienceKind;
  domain?: LearningDomain;
  channel?: SourceCategory;
  personEmail?: string;
  /**
   * Live context hint: true when the user looks overloaded (dense calendar,
   * delayed replies). Cognitive load theory: prefer shorter, more structured
   * output under load. This is contextual state, never a stored trait.
   */
  userBusy?: boolean;
}

export interface PersonalizationConfig {
  verbosity: 'concise' | 'balanced' | 'detailed';
  structure: 'bullets' | 'prose' | 'tables_for_comparisons';
  tone: 'formal' | 'neutral' | 'casual';
  directness: 'direct' | 'softened';
  /** Topics / people (emails) to surface first. */
  emphasize: string[];
  /** Topics / people to rank down (never silently hidden). */
  deemphasize: string[];
  /** Rank risk/loss-framed items first (prospect theory preference). */
  riskFirst: boolean;
  /** Cap on list sizes when the user is overloaded. */
  maxItemsPerSection: number | null;
}

/** One preference that influenced a personalization decision, with its why. */
export interface AppliedPreference {
  preferenceId: string;
  statement: string;
  confidence: number;
  origin: PreferenceOrigin;
  reason: string;
}

export interface PersonalizationResult {
  config: PersonalizationConfig;
  /** Every preference applied and why — outputs must be explainable. */
  applied: AppliedPreference[];
}
