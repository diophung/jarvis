/**
 * Digest service: rescoring -> deterministic planning (@donna/core planDigest)
 * -> persisted digest + digest_items -> optional LLM-written narrative with a
 * guaranteed deterministic fallback. Previous digests are never mutated;
 * regeneration links via supersedesDigestId.
 */
import { DIGEST_SECTIONS, fromJson, newId, nowIso, planDigest, toJson } from '@donna/core';
import type {
  Digest,
  DigestCandidate,
  DigestItem,
  DigestKind,
  DigestPlan,
  DigestSection,
  DigestStatus,
  Level,
  PlanningCategory,
  ScoreSignal,
  SourceCategory,
} from '@donna/core';
import type { Db, DigestItemsTable, DigestsTable } from '@donna/db';
import type { LlmMessage } from '@donna/llm';
import type {
  AuditService,
  DigestService,
  DigestWithItems,
  LlmRouterService,
  ScoringService,
  SettingsService,
} from '../context.js';

const DAY_MS = 86_400_000;
const MAX_PER_SECTION = 5;
const PLAN_MARKER = '---PLAN---';

const SECTION_ORDER = new Map<string, number>(DIGEST_SECTIONS.map((s, i) => [s, i]));

function toDigest(row: DigestsTable): Digest {
  return {
    ...row,
    kind: row.kind as DigestKind,
    status: row.status as DigestStatus,
    stats: fromJson<Record<string, number>>(row.stats, {}),
  };
}

function toDigestItem(row: DigestItemsTable): DigestItem {
  return {
    ...row,
    sourceCategory: (row.sourceCategory ?? null) as SourceCategory | null,
    section: row.section as DigestSection,
    planningCategory: row.planningCategory as PlanningCategory,
    priorityLevel: row.priorityLevel as Level,
    urgencyLevel: row.urgencyLevel as Level,
    effortLevel: row.effortLevel as Level,
    signals: fromJson<ScoreSignal[]>(row.signals, []),
  };
}

function buildNarrativeMessages(plan: DigestPlan, now: string): LlmMessage[] {
  const items = plan.items.map((item) => ({
    title: item.title,
    section: item.section,
    explanation: item.explanation,
    action: item.recommendedAction,
  }));
  const system = [
    'You are Donna, a calm, experienced chief of staff writing a daily debrief for a busy professional.',
    'Tone: composed, direct, practical. No hype, no emojis, no filler, no invented facts.',
    `Respond with two markdown parts separated by a line containing exactly ${PLAN_MARKER}.`,
    'Part 1 (SUMMARY): a short executive summary — a one-line greeting, 2-4 sentences on what matters most today and why, then up to four bullet highlights.',
    'Part 2 (PLAN): a practical day plan under the heading "## Suggested plan", grouped into Morning / Midday / Afternoon where that helps, each entry as a bullet with a concrete next step.',
    'Base everything strictly on the provided items and stats. Mention only items that were provided.',
  ].join('\n');
  const user = JSON.stringify({ date: now, stats: plan.stats, items });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Split LLM output on the marker; null when either part is missing/empty. */
export function parseNarrative(text: string): { summary: string; plan: string } | null {
  const idx = text.indexOf(PLAN_MARKER);
  if (idx === -1) return null;
  const summary = text.slice(0, idx).trim();
  const plan = text.slice(idx + PLAN_MARKER.length).trim();
  if (summary === '' || plan === '') return null;
  return { summary, plan };
}

export function createDigestService(deps: {
  db: Db;
  llm: LlmRouterService;
  scoring: ScoringService;
  audit: AuditService;
  settings: SettingsService;
}): DigestService {
  const { db, llm, scoring, audit } = deps;

  async function get(workspaceId: string, digestId: string): Promise<DigestWithItems | null> {
    const row = await db
      .selectFrom('digests')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', digestId)
      .executeTakeFirst();
    if (!row) return null;
    const itemRows = await db
      .selectFrom('digestItems')
      .selectAll()
      .where('digestId', '=', digestId)
      .execute();
    const items = itemRows
      .map(toDigestItem)
      .sort(
        (a, b) =>
          (SECTION_ORDER.get(a.section) ?? 0) - (SECTION_ORDER.get(b.section) ?? 0) ||
          a.rank - b.rank,
      );
    return { ...toDigest(row), items };
  }

  async function list(workspaceId: string, opts: { limit?: number } = {}): Promise<Digest[]> {
    const rows = await db
      .selectFrom('digests')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(opts.limit ?? 50, 200))
      .execute();
    return rows.map(toDigest);
  }

  async function generate(
    workspaceId: string,
    userId: string,
    opts: { kind: 'daily' | 'manual' | 'scheduled'; supersedesDigestId?: string },
  ): Promise<DigestWithItems> {
    await scoring.rescoreWorkspace(workspaceId);

    const now = nowIso();
    const periodStart = new Date(Date.parse(now) - DAY_MS).toISOString();

    const rows = await db
      .selectFrom('taskCandidates')
      .leftJoin('sourceItems', 'sourceItems.id', 'taskCandidates.sourceItemId')
      .leftJoin('sourceAccounts', 'sourceAccounts.id', 'sourceItems.accountId')
      .select([
        'taskCandidates.id as taskId',
        'taskCandidates.sourceItemId as sourceItemId',
        'taskCandidates.title as title',
        'taskCandidates.importanceScore as importanceScore',
        'taskCandidates.urgencyScore as urgencyScore',
        'taskCandidates.effortScore as effortScore',
        'taskCandidates.overallScore as overallScore',
        'taskCandidates.priorityLevel as priorityLevel',
        'taskCandidates.urgencyLevel as urgencyLevel',
        'taskCandidates.effortLevel as effortLevel',
        'taskCandidates.planningCategory as planningCategory',
        'taskCandidates.signals as signals',
        'taskCandidates.explanation as explanation',
        'taskCandidates.recommendedAction as recommendedAction',
        'sourceItems.category as itemCategory',
        'sourceItems.itemTimestamp as itemTimestamp',
        'sourceAccounts.displayName as sourceLabel',
      ])
      .where('taskCandidates.workspaceId', '=', workspaceId)
      .where('taskCandidates.status', '=', 'open')
      .execute();

    const candidates: DigestCandidate[] = rows.map((row) => ({
      sourceItemId: row.sourceItemId,
      taskCandidateId: row.taskId,
      title: row.title,
      sourceLabel: row.sourceLabel ?? 'Tasks',
      sourceCategory: (row.itemCategory ?? null) as SourceCategory | null,
      itemTimestamp: row.itemTimestamp ?? null,
      score: {
        importance: row.importanceScore,
        urgency: row.urgencyScore,
        effort: row.effortScore,
        overall: row.overallScore,
        priorityLevel: row.priorityLevel as Level,
        urgencyLevel: row.urgencyLevel as Level,
        effortLevel: row.effortLevel as Level,
        planningCategory: row.planningCategory as PlanningCategory,
        signals: fromJson<ScoreSignal[]>(row.signals, []),
        explanation: row.explanation ?? '',
        recommendedAction: row.recommendedAction ?? '',
      },
    }));

    const plan = planDigest(candidates, { now, maxPerSection: MAX_PER_SECTION });

    const digestId = newId('dig');
    await db
      .insertInto('digests')
      .values({
        id: digestId,
        workspaceId,
        userId,
        kind: opts.kind,
        status: 'generating',
        generatedAt: null,
        periodStart,
        periodEnd: now,
        summaryMarkdown: null,
        planMarkdown: null,
        modelUsed: null,
        stats: toJson(plan.stats),
        supersedesDigestId: opts.supersedesDigestId ?? null,
        error: null,
        createdAt: now,
      })
      .execute();

    if (plan.items.length > 0) {
      await db
        .insertInto('digestItems')
        .values(
          plan.items.map((item) => ({
            id: newId('dgi'),
            digestId,
            workspaceId,
            sourceItemId: item.sourceItemId,
            taskCandidateId: item.taskCandidateId,
            title: item.title,
            sourceLabel: item.sourceLabel,
            sourceCategory: item.sourceCategory,
            itemTimestamp: item.itemTimestamp,
            section: item.section,
            planningCategory: item.planningCategory,
            priorityLevel: item.priorityLevel,
            urgencyLevel: item.urgencyLevel,
            effortLevel: item.effortLevel,
            recommendedAction: item.recommendedAction,
            explanation: item.explanation,
            signals: toJson(item.signals),
            rank: item.rank,
            createdAt: now,
          })),
        )
        .execute();
    }

    // Narrative: LLM-written when a real digest provider is routed; otherwise
    // (and on ANY failure) the deterministic planner fallback.
    let summaryMarkdown = plan.fallbackSummaryMarkdown;
    let planMarkdown = plan.fallbackPlanMarkdown;
    let modelUsed: string | null = null;
    try {
      const routed = await llm.clientForTask(workspaceId, 'digest', { digestId }, userId);
      if (!routed.isMock) {
        const result = await routed.client.chat(
          {
            model: routed.model,
            messages: buildNarrativeMessages(plan, now),
            temperature: routed.params.temperature,
            maxTokens: routed.params.maxTokens,
          },
          'digest',
        );
        const parsed = parseNarrative(result.text);
        if (parsed !== null) {
          summaryMarkdown = parsed.summary;
          planMarkdown = parsed.plan;
          modelUsed = result.model !== '' ? result.model : routed.model;
        }
      }
    } catch {
      // Fall back to the deterministic markdown.
    }

    await db
      .updateTable('digests')
      .set({
        status: 'ready',
        generatedAt: nowIso(),
        summaryMarkdown,
        planMarkdown,
        modelUsed,
      })
      .where('id', '=', digestId)
      .execute();

    await audit.log({
      workspaceId,
      userId,
      eventType: 'digest.generated',
      actor: opts.kind === 'scheduled' ? 'worker' : 'user',
      targetType: 'digest',
      targetId: digestId,
      summary: `Digest generated (${opts.kind}) with ${plan.items.length} items`,
      metadata: { kind: opts.kind, itemCount: plan.items.length, model: modelUsed },
    });

    const full = await get(workspaceId, digestId);
    if (full === null) throw new Error(`digest ${digestId} missing after generation`);
    return full;
  }

  return { generate, list, get };
}
