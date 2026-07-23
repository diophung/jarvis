/**
 * Scoring service: builds the workspace ScoringContext (people, projects,
 * preferences, feedback signals) and rescores recent source items into
 * task_candidates using the deterministic @jarvis/core engine, with optional
 * LLM-assisted refinement when a real classification provider is routed.
 */
import {
  applyRefinement,
  fromJson,
  newId,
  nowIso,
  PLANNING_CATEGORIES,
  scoreItem,
  toJson,
} from '@jarvis/core';
import type {
  FeedbackSignal,
  LlmScoreRefinement,
  PersonImportance,
  PersonRef,
  PersonSignal,
  PriorityScore,
  ProjectSignal,
  ScorableItem,
  ScoringContext,
  ScoringPreferences,
  SourceCategory,
} from '@jarvis/core';
import type { Db, SourceItemsTable } from '@jarvis/db';
import { generateStructured } from '@jarvis/llm';
import { z } from 'zod';
import type { AuditService, LlmRouterService, ScoringService } from '../context.js';

const DAY_MS = 86_400_000;
const DEFAULT_SINCE_DAYS = 14;
const LLM_REFINE_TOP_N = 10;

/** Derived preference keys maintained by the feedback service. */
export const FEEDBACK_PREF_KEYS = {
  sendersImportant: 'feedback.senders.important',
  sendersNotImportant: 'feedback.senders.notImportant',
  topicsMoreLikeThis: 'feedback.topics.moreLikeThis',
} as const;

const TITLE_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'their',
  'there',
  'these',
  'this',
  'that',
  'with',
  'from',
  'have',
  'will',
  'your',
  'please',
  'update',
  'reminder',
  'meeting',
  'today',
  'tomorrow',
  'need',
  'needs',
  'them',
  'they',
  'over',
  'into',
  'what',
  'when',
  'where',
]);

/** Extract up to `max` distinct meaningful keywords from a title. */
export function extractTitleKeywords(title: string, max = 3): string[] {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w));
  const out: string[] = [];
  for (const word of words) {
    if (!out.includes(word)) out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

const ScoreSignalSchema = z.object({
  key: z.string(),
  label: z.string(),
  weight: z.number(),
  detail: z.string().optional(),
});

const RefinementSchema: z.ZodType<LlmScoreRefinement> = z.object({
  importanceDelta: z.number().optional(),
  urgencyDelta: z.number().optional(),
  effortDelta: z.number().optional(),
  planningCategory: z.enum(PLANNING_CATEGORIES).optional(),
  explanation: z.string().optional(),
  recommendedAction: z.string().optional(),
  extraSignals: z.array(ScoreSignalSchema).optional(),
});

const REFINEMENT_SCHEMA_DESCRIPTION = [
  'An object refining a rule-based priority score for one work item. Fields (ALL optional; omit anything you would not change):',
  '"importanceDelta": number between -15 and 15 to adjust the importance score;',
  '"urgencyDelta": number between -15 and 15 to adjust the urgency score;',
  '"effortDelta": number between -15 and 15 to adjust the effort score;',
  `"planningCategory": one of ${PLANNING_CATEGORIES.map((c) => `"${c}"`).join(', ')};`,
  '"explanation": one short sentence explaining why this item matters;',
  '"recommendedAction": one short imperative next step for the user;',
  '"extraSignals": array of { "key": string, "label": string, "weight": number, "detail"?: string } describing additional contributing signals.',
].join(' ');

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v !== '' && !out.includes(v)) out.push(v);
  }
  return out;
}

export function createScoringService(deps: {
  db: Db;
  llm: LlmRouterService;
  audit: AuditService;
}): ScoringService {
  const { db, llm } = deps;

  async function buildContext(workspaceId: string, now: string): Promise<ScoringContext> {
    const peopleRows = await db
      .selectFrom('people')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();

    const people: PersonSignal[] = peopleRows.map((row) => ({
      personId: row.id,
      displayName: row.displayName,
      emails: fromJson<string[]>(row.emails, []),
      handles: fromJson<string[]>(row.handles, []),
      importance: row.importance as PersonImportance,
      interactionCount: row.interactionCount,
    }));

    const ownerRows = await db
      .selectFrom('workspaces')
      .innerJoin('users', 'users.id', 'workspaces.ownerUserId')
      .select('users.email as email')
      .where('workspaces.id', '=', workspaceId)
      .execute();
    const selfEmails = uniqueStrings([
      ...ownerRows.map((r) => r.email.toLowerCase()),
      ...peopleRows
        .filter((p) => p.isSelf === 1)
        .flatMap((p) => fromJson<string[]>(p.emails, []).map((e) => e.toLowerCase())),
    ]);

    const projectRows = await db
      .selectFrom('projects')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    const projects: ProjectSignal[] = projectRows.map((row) => ({
      projectId: row.id,
      name: row.name,
      keywords: fromJson<string[]>(row.keywords, []),
      priority: row.priority as ProjectSignal['priority'],
      status: row.status,
      dueAt: row.dueAt,
    }));

    const prefRows = await db
      .selectFrom('userPreferences')
      .select(['key', 'value'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    const strArr = (key: string): string[] => fromJson<string[]>(prefMap.get(key), []);

    const preferences: ScoringPreferences = {
      topicsPrioritize: uniqueStrings([
        ...strArr('topics.prioritize'),
        ...strArr(FEEDBACK_PREF_KEYS.topicsMoreLikeThis),
      ]),
      topicsIgnore: strArr('topics.ignore'),
      sourcesPrioritize: strArr('sources.prioritize'),
      sourcesIgnore: strArr('sources.ignore'),
    };
    const workingHours = fromJson<{ start?: string; end?: string }>(
      prefMap.get('workingHours'),
      {},
    );
    if (typeof workingHours.start === 'string') preferences.workingHoursStart = workingHours.start;
    if (typeof workingHours.end === 'string') preferences.workingHoursEnd = workingHours.end;

    // Feedback signals: item_feedback rows joined to their source items.
    const feedbackRows = await db
      .selectFrom('itemFeedback')
      .select(['kind', 'sourceItemId', 'taskCandidateId'])
      .where('workspaceId', '=', workspaceId)
      .execute();

    const taskIds = uniqueStrings(
      feedbackRows.flatMap((f) =>
        f.sourceItemId === null && f.taskCandidateId !== null ? [f.taskCandidateId] : [],
      ),
    );
    const taskRows =
      taskIds.length > 0
        ? await db
            .selectFrom('taskCandidates')
            .select(['id', 'sourceItemId'])
            .where('workspaceId', '=', workspaceId)
            .where('id', 'in', taskIds)
            .execute()
        : [];
    const taskToItem = new Map(taskRows.map((t) => [t.id, t.sourceItemId]));

    const resolveItemId = (f: (typeof feedbackRows)[number]): string | null =>
      f.sourceItemId ?? (f.taskCandidateId !== null ? (taskToItem.get(f.taskCandidateId) ?? null) : null);

    const itemIds = uniqueStrings(feedbackRows.flatMap((f) => {
      const id = resolveItemId(f);
      return id !== null ? [id] : [];
    }));
    const itemRows =
      itemIds.length > 0
        ? await db
            .selectFrom('sourceItems')
            .select(['id', 'title', 'sender', 'category'])
            .where('workspaceId', '=', workspaceId)
            .where('id', 'in', itemIds)
            .execute()
        : [];
    const itemMap = new Map(itemRows.map((i) => [i.id, i]));

    const feedback: FeedbackSignal[] = [];
    for (const f of feedbackRows) {
      const itemId = resolveItemId(f);
      const item = itemId !== null ? itemMap.get(itemId) : undefined;
      if (!item) continue;
      const signal: FeedbackSignal = { kind: f.kind, category: item.category as SourceCategory };
      const sender = fromJson<PersonRef | null>(item.sender, null);
      if (sender?.email !== undefined && sender.email !== '') signal.senderEmail = sender.email;
      const keywords = extractTitleKeywords(item.title);
      if (keywords.length > 0) signal.keywords = keywords;
      feedback.push(signal);
    }
    // Derived sender preferences (maintained by the feedback service) also act
    // as standing feedback signals.
    for (const email of strArr(FEEDBACK_PREF_KEYS.sendersImportant)) {
      feedback.push({ kind: 'important', senderEmail: email });
    }
    for (const email of strArr(FEEDBACK_PREF_KEYS.sendersNotImportant)) {
      feedback.push({ kind: 'not_important', senderEmail: email });
    }

    return { now, people, projects, preferences, feedback, selfEmails };
  }

  async function rescoreWorkspace(
    workspaceId: string,
    opts: { sinceDays?: number } = {},
  ): Promise<{ scored: number }> {
    const now = nowIso();
    const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
    const sinceIso = new Date(Date.parse(now) - sinceDays * DAY_MS).toISOString();

    const itemRows = await db
      .selectFrom('sourceItems')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where((eb) =>
        eb.or([
          eb('itemTimestamp', '>=', sinceIso),
          eb.and([eb('dueAt', 'is not', null), eb('dueAt', '>', now)]),
          eb.and([eb('startsAt', 'is not', null), eb('startsAt', '>', now)]),
        ]),
      )
      .execute();
    if (itemRows.length === 0) return { scored: 0 };

    const ctx = await buildContext(workspaceId, now);

    const attachRows = await db
      .selectFrom('sourceAttachments')
      .select(['itemId'])
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspaceId', '=', workspaceId)
      .groupBy('itemId')
      .execute();
    const attachCounts = new Map(attachRows.map((r) => [r.itemId, Number(r.n)]));

    const scored = itemRows.map((row) => ({
      row,
      score: scoreItem(toScorable(row, attachCounts.get(row.id) ?? 0), ctx),
    }));

    // Optional LLM refinement — never required, any failure keeps rule output.
    try {
      const routed = await llm.clientForTask(workspaceId, 'classification');
      if (!routed.isMock) {
        const top = [...scored]
          .sort((a, b) => b.score.overall - a.score.overall)
          .slice(0, LLM_REFINE_TOP_N);
        for (const entry of top) {
          try {
            const payload = {
              title: entry.row.title,
              category: entry.row.category,
              snippet: entry.row.snippet ?? entry.row.bodyText?.slice(0, 400) ?? '',
              dueAt: entry.row.dueAt,
              startsAt: entry.row.startsAt,
              ruleScore: {
                importance: entry.score.importance,
                urgency: entry.score.urgency,
                effort: entry.score.effort,
                planningCategory: entry.score.planningCategory,
                explanation: entry.score.explanation,
              },
            };
            const result = await generateStructured(
              routed.client,
              {
                model: routed.model,
                messages: [
                  {
                    role: 'user',
                    content: `Refine the priority assessment of this work item:\n${JSON.stringify(payload)}`,
                  },
                ],
                temperature: routed.params.temperature,
                maxTokens: routed.params.maxTokens,
              },
              {
                schema: RefinementSchema,
                schemaName: 'LlmScoreRefinement',
                schemaDescription: REFINEMENT_SCHEMA_DESCRIPTION,
              },
            );
            if (result.value !== null) {
              entry.score = applyRefinement(entry.score, result.value);
            }
          } catch {
            // Keep the deterministic score for this item.
          }
        }
      }
    } catch {
      // No usable classification client — deterministic results stand.
    }

    const existingRows = await db
      .selectFrom('taskCandidates')
      .select(['id', 'sourceItemId'])
      .where('workspaceId', '=', workspaceId)
      .where('origin', '=', 'scoring')
      .where(
        'sourceItemId',
        'in',
        itemRows.map((r) => r.id),
      )
      .execute();
    const existingByItem = new Map(existingRows.map((r) => [r.sourceItemId, r.id]));

    for (const { row, score } of scored) {
      const patch = scoreColumns(score, row.dueAt, now);
      const existingId = existingByItem.get(row.id);
      if (existingId !== undefined) {
        // Never touch status here: user-set done/deferred/dismissed must stick.
        await db.updateTable('taskCandidates').set(patch).where('id', '=', existingId).execute();
      } else {
        await db
          .insertInto('taskCandidates')
          .values({
            id: newId('tsk'),
            workspaceId,
            sourceItemId: row.id,
            title: row.title,
            description: row.snippet,
            status: 'open',
            deferredUntil: null,
            projectId: null,
            peopleIds: row.peopleIds,
            origin: 'scoring',
            createdAt: now,
            ...patch,
          })
          .execute();
      }
    }

    return { scored: scored.length };
  }

  return { buildContext, rescoreWorkspace };
}

function toScorable(row: SourceItemsTable, attachmentCount: number): ScorableItem {
  return {
    id: row.id,
    category: row.category as SourceCategory,
    provider: row.provider,
    title: row.title,
    bodyText: row.bodyText,
    snippet: row.snippet,
    sender: fromJson<PersonRef | null>(row.sender, null),
    participants: fromJson<PersonRef[]>(row.participants, []),
    itemTimestamp: row.itemTimestamp,
    dueAt: row.dueAt,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    threadExternalId: row.threadExternalId,
    labels: fromJson<string[]>(row.labels, []),
    isRead: row.isRead,
    attachmentCount,
    bodyLength: row.bodyText?.length ?? 0,
  };
}

function scoreColumns(score: PriorityScore, dueAt: string | null, now: string) {
  return {
    importanceScore: score.importance,
    urgencyScore: score.urgency,
    effortScore: score.effort,
    overallScore: score.overall,
    priorityLevel: score.priorityLevel,
    urgencyLevel: score.urgencyLevel,
    effortLevel: score.effortLevel,
    planningCategory: score.planningCategory,
    signals: toJson(score.signals),
    explanation: score.explanation,
    recommendedAction: score.recommendedAction,
    dueAt,
    updatedAt: now,
  };
}
