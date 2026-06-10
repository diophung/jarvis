/**
 * Priority scoring contracts. The engine is deterministic-rules-first; an
 * optional LLM-assisted classification can refine results but the system must
 * fully work without any LLM configured.
 */
import type { PersonRef, ScoreSignal } from '../entities.js';
import type { Level, PlanningCategory, SourceCategory } from '../enums.js';

/** The subset of a SourceItem the scorer needs. */
export interface ScorableItem {
  id: string;
  category: SourceCategory;
  provider: string;
  title: string;
  bodyText: string | null;
  snippet: string | null;
  sender: PersonRef | null;
  participants: PersonRef[];
  itemTimestamp: string;
  dueAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  threadExternalId: string | null;
  labels: string[];
  isRead: number;
  attachmentCount?: number;
  bodyLength?: number;
}

export interface PersonSignal {
  personId: string;
  displayName: string;
  emails: string[];
  handles: string[];
  importance: 'vip' | 'high' | 'normal' | 'low' | 'ignore';
  interactionCount: number;
}

export interface ProjectSignal {
  projectId: string;
  name: string;
  keywords: string[];
  priority: 'high' | 'normal' | 'low';
  status: string;
  dueAt: string | null;
}

export interface FeedbackSignal {
  kind: string;
  /** Tokens extracted from items the feedback applied to (sender email, keywords). */
  senderEmail?: string;
  keywords?: string[];
  category?: SourceCategory;
}

export interface ScoringPreferences {
  /** e.g. topics to prioritize / ignore, sources to prioritize / ignore. */
  topicsPrioritize: string[];
  topicsIgnore: string[];
  sourcesPrioritize: string[];
  sourcesIgnore: string[];
  workingHoursStart?: string; // "09:00"
  workingHoursEnd?: string; // "18:00"
}

export interface ScoringContext {
  /** ISO timestamp to score relative to. */
  now: string;
  people: PersonSignal[];
  projects: ProjectSignal[];
  preferences: ScoringPreferences;
  feedback: FeedbackSignal[];
  /** The user's own identifiers, to detect direct mentions/addressing. */
  selfEmails: string[];
}

export interface PriorityScore {
  importance: number; // 0..100
  urgency: number; // 0..100
  effort: number; // 0..100
  overall: number; // 0..100
  priorityLevel: Level;
  urgencyLevel: Level;
  effortLevel: Level;
  planningCategory: PlanningCategory;
  signals: ScoreSignal[];
  /** Short human-readable "why this matters". */
  explanation: string;
  recommendedAction: string;
}

/** Optional refinement coming from an LLM classifier; merged over rule output. */
export interface LlmScoreRefinement {
  importanceDelta?: number;
  urgencyDelta?: number;
  effortDelta?: number;
  planningCategory?: PlanningCategory;
  explanation?: string;
  recommendedAction?: string;
  extraSignals?: ScoreSignal[];
}
