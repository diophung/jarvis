/**
 * Digest planning contracts. The planner is deterministic: it selects and
 * groups scored items into debrief sections. The LLM (when configured) only
 * writes the narrative summary and day plan on top of the planner output.
 */
import type { ScoreSignal } from '../entities.js';
import type { DigestSection, Level, PlanningCategory, SourceCategory } from '../enums.js';
import type { PriorityScore } from '../scoring/types.js';

export interface DigestCandidate {
  sourceItemId: string | null;
  taskCandidateId: string | null;
  title: string;
  sourceLabel: string;
  sourceCategory: SourceCategory | null;
  itemTimestamp: string | null;
  score: PriorityScore;
}

export interface PlannedDigestItem {
  sourceItemId: string | null;
  taskCandidateId: string | null;
  title: string;
  sourceLabel: string;
  sourceCategory: SourceCategory | null;
  itemTimestamp: string | null;
  section: DigestSection;
  planningCategory: PlanningCategory;
  priorityLevel: Level;
  urgencyLevel: Level;
  effortLevel: Level;
  recommendedAction: string | null;
  explanation: string;
  signals: ScoreSignal[];
  rank: number;
}

export interface DigestPlan {
  items: PlannedDigestItem[];
  /** Per-section counts for the stats column. */
  stats: Record<string, number>;
  /** Deterministic fallback summary used when no LLM is configured. */
  fallbackSummaryMarkdown: string;
  fallbackPlanMarkdown: string;
}

export interface DigestPlannerOptions {
  /** Max items per section. */
  maxPerSection?: number;
  now: string;
}
