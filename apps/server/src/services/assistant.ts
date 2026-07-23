/**
 * Assistant service — the product's brain.
 *
 * respond() loads the conversation, assembles real workspace context
 * (memories, retrieval, open priorities, upcoming calendar, latest digest),
 * routes to the configured chat model (or a deterministic demo answerer when
 * running in demo/mock mode), streams the reply as AssistantStreamEvents,
 * detects conservative agentic intents (draft/send/schedule/post) which go
 * through the policy-gated actions service, captures durable preferences into
 * memory, and persists the final assistant message.
 */
import {
  fromJson,
  newId,
  nowIso,
  PLANNING_CATEGORIES,
  PLANNING_CATEGORY_LABELS,
  toJson,
  type AppliedPreference,
  type Citation,
  type MemoryEntry,
  type Message,
  type PersonRef,
  type PlanningCategory,
  type ScoreSignal,
  type SuggestedAction,
} from '@jarvis/core';
import type { Db } from '@jarvis/db';
import type { LlmMessage } from '@jarvis/llm';
import {
  SETTING_KEYS,
  type ActionsService,
  type AssistantService,
  type AssistantStreamEvent,
  type AuditService,
  type LearningService,
  type LlmRouterService,
  type MemoryService,
  type PersonalizationService,
  type ProposeActionInput,
  type RetrievalService,
  type SearchResult,
  type SettingsService,
} from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

export interface AssistantServiceDeps {
  db: Db;
  llm: LlmRouterService;
  retrieval: RetrievalService;
  memory: MemoryService;
  actions: ActionsService;
  settings: SettingsService;
  audit: AuditService;
  /** Optional self-learning hooks (explicit-statement capture + personalization). */
  learning?: LearningService;
  personalization?: PersonalizationService;
}

const DEMO_FOOTER =
  '_Demo mode: this answer was generated from your data without an AI model. Configure one in Settings → AI Providers for full reasoning._';

const MEMORY_NOTE = "Noted — I'll remember that.";

const MEMORY_TRIGGER = /\b(always|never|prefer|from now on|remember that)\b/i;

const FRIENDLY_ERROR =
  'Sorry — I ran into a problem while preparing this answer. Please try again in a moment.';

const CALENDAR_HORIZON_MS = 36 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  sourceItemId: string | null;
  title: string;
  description: string | null;
  planningCategory: PlanningCategory;
  overallScore: number;
  importanceScore: number;
  urgencyScore: number;
  effortScore: number;
  effortLevel: string;
  explanation: string | null;
  recommendedAction: string | null;
  signals: ScoreSignal[];
  sourceLabel: string;
  sourceCategory: string | null;
  sender: PersonRef | null;
  snippet: string | null;
}

interface CalendarRow {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  provider: string;
  participants: PersonRef[];
  snippet: string | null;
}

interface AssembledContext {
  memories: MemoryEntry[];
  responseStyle: string;
  results: SearchResult[];
  tasks: TaskRow[];
  calendar: CalendarRow[];
  digestSummary: string | null;
  /** Learned preferences applied to this reply, with reasons (explainable personalization). */
  appliedPreferences: AppliedPreference[];
}

type DemoIntent =
  | 'attention'
  | 'meetings'
  | 'emails'
  | 'blocked'
  | 'missed'
  | 'ignore'
  | 'delegate'
  | 'effort'
  | 'overview';

type AgentIntent = 'draft' | 'send' | 'schedule' | 'post';

interface AgentOutcome {
  note: string;
  approvalId: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function senderName(t: TaskRow): string {
  return t.sender?.name ?? t.sender?.email ?? 'unknown sender';
}

function signalText(t: TaskRow): string {
  return t.signals
    .map((s) => `${s.key} ${s.label} ${s.detail ?? ''}`)
    .join(' ')
    .toLowerCase();
}

function isVipish(t: TaskRow): boolean {
  return (
    /sender_vip|sender_high|frequent_contact|key stakeholder|directly_addressed/.test(
      signalText(t),
    ) || t.importanceScore >= 70
  );
}

function taskLine(t: TaskRow): string {
  const why =
    t.explanation ??
    (t.signals.length > 0
      ? `signals: ${t.signals
          .slice(0, 2)
          .map((s) => s.label)
          .join(', ')}`
      : 'prioritized from your recent activity');
  const action = t.recommendedAction !== null ? `\n  - Recommended: ${t.recommendedAction}` : '';
  return `- **${t.title}** _(${t.sourceLabel}, score ${Math.round(t.overallScore)})_ — ${why}${action}`;
}

function formatWhen(iso: string | null): string {
  if (iso === null) return 'time TBD';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

async function loadTopTasks(db: Db, workspaceId: string): Promise<TaskRow[]> {
  const rows = await db
    .selectFrom('taskCandidates')
    .leftJoin('sourceItems', 'sourceItems.id', 'taskCandidates.sourceItemId')
    .selectAll('taskCandidates')
    .select([
      'sourceItems.provider as srcProvider',
      'sourceItems.category as srcCategory',
      'sourceItems.sender as srcSender',
      'sourceItems.snippet as srcSnippet',
    ])
    .where('taskCandidates.workspaceId', '=', workspaceId)
    .where('taskCandidates.status', '=', 'open')
    .orderBy('taskCandidates.overallScore', 'desc')
    .limit(10)
    .execute();
  return rows.map(
    (r): TaskRow => ({
      id: r.id,
      sourceItemId: r.sourceItemId,
      title: r.title,
      description: r.description,
      planningCategory: r.planningCategory as PlanningCategory,
      overallScore: r.overallScore,
      importanceScore: r.importanceScore,
      urgencyScore: r.urgencyScore,
      effortScore: r.effortScore,
      effortLevel: r.effortLevel,
      explanation: r.explanation,
      recommendedAction: r.recommendedAction,
      signals: fromJson<ScoreSignal[]>(r.signals, []),
      sourceLabel: r.srcProvider ?? 'internal',
      sourceCategory: r.srcCategory ?? null,
      sender: fromJson<PersonRef | null>(r.srcSender, null),
      snippet: r.srcSnippet ?? null,
    }),
  );
}

async function loadUpcomingCalendar(
  db: Db,
  workspaceId: string,
  fromIso: string,
  toIso: string,
): Promise<CalendarRow[]> {
  const rows = await db
    .selectFrom('sourceItems')
    .selectAll()
    .where('workspaceId', '=', workspaceId)
    .where('category', '=', 'calendar')
    .where('startsAt', '>=', fromIso)
    .where('startsAt', '<=', toIso)
    .orderBy('startsAt', 'asc')
    .limit(10)
    .execute();
  return rows.map(
    (r): CalendarRow => ({
      id: r.id,
      title: r.title,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      provider: r.provider,
      participants: fromJson<PersonRef[]>(r.participants, []),
      snippet: r.snippet,
    }),
  );
}

/**
 * Graceful degradation: each context source falls back independently. A
 * failing memory/retrieval/digest lookup must never turn into a 500 — Jarvis
 * answers from whatever context IS available (the failure is logged, never
 * shown as a crash).
 */
async function withFallback<T>(label: string, fallback: T, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    console.warn(
      `[assistant] ${label} unavailable, continuing degraded: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fallback;
  }
}

async function assembleContext(
  deps: AssistantServiceDeps,
  workspaceId: string,
  userId: string,
  query: string,
): Promise<AssembledContext> {
  const { db, memory, retrieval, settings, personalization } = deps;
  const now = Date.now();
  const [memories, responseStyle, retrieved, tasks, calendar, digestRow, personalized] =
    await Promise.all([
      withFallback('memory', [], () => memory.relevant(workspaceId, query, 5)),
      withFallback('settings', 'concise', () =>
        settings.get<string>(workspaceId, SETTING_KEYS.responseStyle, 'concise'),
      ),
      withFallback('retrieval', { results: [], mode: 'keyword' as const }, () =>
        retrieval.search(workspaceId, query, { limit: 8 }),
      ),
      withFallback('tasks', [], () => loadTopTasks(db, workspaceId)),
      withFallback('calendar', [], () =>
        loadUpcomingCalendar(
          db,
          workspaceId,
          new Date(now).toISOString(),
          new Date(now + CALENDAR_HORIZON_MS).toISOString(),
        ),
      ),
      withFallback('digest', undefined, () =>
        db
          .selectFrom('digests')
          .select(['id', 'summaryMarkdown'])
          .where('workspaceId', '=', workspaceId)
          .where('status', '=', 'ready')
          .orderBy('createdAt', 'desc')
          .limit(1)
          .executeTakeFirst(),
      ),
      personalization !== undefined
        ? personalization
            .forTask(workspaceId, userId, { task: 'chat_reply', channel: 'chat' })
            .catch(() => null)
        : Promise.resolve(null),
    ]);
  return {
    memories,
    responseStyle,
    results: retrieved.results,
    tasks,
    calendar,
    digestSummary: digestRow?.summaryMarkdown ?? null,
    appliedPreferences: personalized?.applied ?? [],
  };
}

// ---------------------------------------------------------------------------
// Demo-mode deterministic answerer
// ---------------------------------------------------------------------------

export function detectDemoIntent(query: string): DemoIntent {
  const q = query.toLowerCase();
  if (/attention|\btoday\b|priorit/.test(q)) return 'attention';
  if (/meeting|prepare/.test(q)) return 'meetings';
  if (/email/.test(q) && /important|unread|vip/.test(q)) return 'emails';
  if (/\bblocked\b|\bblockers?\b/.test(q)) return 'blocked';
  if (/\bmiss(ed|ing)?\b/.test(q)) return 'missed';
  if (/ignore/.test(q)) return 'ignore';
  if (/delegate/.test(q)) return 'delegate';
  if (/effort/.test(q)) return 'effort';
  return 'overview';
}

interface DemoAnswer {
  body: string;
  usedTasks: TaskRow[];
}

function listTasks(lines: string[], used: TaskRow[], tasks: TaskRow[], limit: number): void {
  for (const t of tasks.slice(0, limit)) {
    lines.push(taskLine(t));
    used.push(t);
  }
}

export function composeDemoAnswer(query: string, ctx: AssembledContext): DemoAnswer {
  const intent = detectDemoIntent(query);
  const { tasks, calendar } = ctx;
  const lines: string[] = [];
  const used: TaskRow[] = [];

  switch (intent) {
    case 'attention': {
      if (tasks.length === 0) {
        lines.push(
          "I don't see any open priorities yet — connect or sync a source and I'll start triaging for you.",
        );
        break;
      }
      lines.push("Here's what needs your attention right now:", '');
      const byCategory = new Map<PlanningCategory, TaskRow[]>();
      for (const t of tasks) {
        const group = byCategory.get(t.planningCategory) ?? [];
        group.push(t);
        byCategory.set(t.planningCategory, group);
      }
      for (const category of PLANNING_CATEGORIES) {
        const group = byCategory.get(category);
        if (group === undefined || group.length === 0) continue;
        lines.push(`**${PLANNING_CATEGORY_LABELS[category]}**`);
        listTasks(lines, used, group, 3);
        lines.push('');
      }
      break;
    }
    case 'meetings': {
      if (calendar.length === 0) {
        lines.push(
          'You have no meetings in the next 36 hours, so nothing needs prep right now. Enjoy the focus time.',
        );
        break;
      }
      const plural = calendar.length === 1 ? 'meeting' : 'meetings';
      lines.push(`You have ${calendar.length} ${plural} in the next 36 hours:`, '');
      for (const event of calendar) {
        const attendees =
          event.participants.length > 0 ? ` · ${event.participants.length} attendees` : '';
        lines.push(`- **${event.title}** — ${formatWhen(event.startsAt)}${attendees}`);
        const prepTask = tasks.find((t) => t.sourceItemId === event.id);
        const prep =
          prepTask?.recommendedAction ??
          'Skim the invite and any related threads beforehand so you walk in ready.';
        lines.push(`  - Prep: ${prep}`);
        if (prepTask !== undefined) used.push(prepTask);
      }
      break;
    }
    case 'emails': {
      let pool = tasks.filter((t) => t.sourceCategory === 'email' && isVipish(t));
      if (pool.length === 0) {
        pool = tasks.filter((t) => t.sourceCategory === 'email');
        if (pool.length === 0) {
          lines.push(
            "I don't see any open email items right now. Once your mail source syncs, I'll flag the important ones here.",
          );
          break;
        }
        lines.push(
          "I couldn't single out VIP senders, so here are your highest-scoring emails:",
          '',
        );
      } else {
        lines.push('Important emails that still need you:', '');
      }
      for (const t of pool.slice(0, 5)) {
        lines.push(`- **${t.title}** — from ${senderName(t)}`);
        lines.push(`  - Why: ${t.explanation ?? 'high combined importance and urgency'}`);
        if (t.recommendedAction !== null) lines.push(`  - Recommended: ${t.recommendedAction}`);
        used.push(t);
      }
      break;
    }
    case 'blocked': {
      const pool = tasks.filter((t) =>
        /block|escalat/.test(`${signalText(t)} ${t.title} ${t.description ?? ''}`.toLowerCase()),
      );
      if (pool.length === 0) {
        lines.push(
          "Nothing in your open items signals a blocker or escalation right now. I'll flag it the moment something does.",
        );
        break;
      }
      lines.push('These items look blocked or are escalating:', '');
      listTasks(lines, used, pool, 5);
      break;
    }
    case 'missed': {
      const pool = tasks.filter((t) => /stale|unread|awaiting|no reply/.test(signalText(t)));
      if (pool.length === 0) {
        lines.push(
          "I don't see anything that slipped through — no stale threads or unread high-priority items in your open queue.",
        );
        break;
      }
      lines.push('You may have missed these — they have gone stale or unread:', '');
      listTasks(lines, used, pool, 5);
      break;
    }
    case 'ignore': {
      const pool = tasks.filter((t) => t.planningCategory === 'low_priority');
      if (pool.length === 0) {
        lines.push(
          'Nothing currently looks safely ignorable — every open item carries at least one meaningful signal.',
        );
        break;
      }
      lines.push('These look safe to ignore for now (low priority across the board):', '');
      listTasks(lines, used, pool, 5);
      break;
    }
    case 'delegate': {
      const pool = tasks.filter(
        (t) =>
          (t.effortLevel === 'high' || t.effortLevel === 'critical' || t.effortScore >= 50) &&
          !isVipish(t),
      );
      if (pool.length === 0) {
        lines.push(
          "I don't see high-effort items that are clearly delegable — the heavy items involve key people and likely need you directly.",
        );
        break;
      }
      lines.push('Good delegation candidates — high effort, not tied to key stakeholders:', '');
      listTasks(lines, used, pool, 5);
      break;
    }
    case 'effort': {
      if (tasks.length === 0) {
        lines.push('No open items to size up yet — sync a source and I can estimate effort.');
        break;
      }
      lines.push('Your open items ranked by estimated effort:', '');
      const ranked = [...tasks].sort((a, b) => b.effortScore - a.effortScore);
      for (const t of ranked.slice(0, 5)) {
        lines.push(
          `- **${t.title}** — effort ${t.effortLevel} (${Math.round(t.effortScore)}/100)${
            t.explanation !== null ? ` — ${t.explanation}` : ''
          }`,
        );
        used.push(t);
      }
      break;
    }
    case 'overview': {
      if (tasks.length === 0) {
        lines.push(
          "Nothing is queued up yet. Connect a source or upload a document and I'll start prioritizing.",
        );
      } else {
        lines.push('Your top priorities right now:', '');
        listTasks(lines, used, tasks, 3);
      }
      lines.push(
        '',
        'You can also ask me what needs attention today, what to prepare before meetings, which emails matter, what is blocked, or what you can safely ignore or delegate.',
      );
      break;
    }
  }

  // Trim trailing blank lines so the joined sections stay clean.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { body: lines.join('\n'), usedTasks: used };
}

function streamDemoText(
  text: string,
  send: (event: AssistantStreamEvent) => void,
  abortSignal?: AbortSignal,
): void {
  const words = text.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    if (abortSignal?.aborted === true) return;
    const word = words[i] ?? '';
    const piece = i < words.length - 1 ? `${word} ` : word;
    if (piece.length > 0) send({ type: 'delta', text: piece });
  }
}

// ---------------------------------------------------------------------------
// LLM path prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(userName: string, responseStyle: string, now: Date): string {
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    // keep UTC
  }
  return [
    `You are Jarvis, ${userName}'s executive assistant — sharp, warm, and concise.`,
    '',
    'Guidelines:',
    '- Lead with what matters most. Keep answers structured: short sections, bold key items, brief why-lines, concrete next steps.',
    '- Be honest about uncertainty and missing data; say plainly when you do not know or when the data is absent.',
    '- Cite sources inline as [1]..[n], matching the numbered snippets in the CONTEXT block. Never cite a number that does not exist.',
    `- The user prefers ${responseStyle} responses.`,
    `- Current time: ${now.toISOString()} (timezone: ${timezone}).`,
    '- Never invent emails, meetings, people, dates, or facts that are not in the CONTEXT block or the conversation.',
  ].join('\n');
}

function buildContextBlock(ctx: AssembledContext): string {
  const lines: string[] = [
    'CONTEXT — data Jarvis retrieved for this question. Cite snippets as [n].',
    '',
    'Numbered snippets:',
  ];
  if (ctx.results.length === 0) lines.push('(none)');
  ctx.results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title} — ${r.sourceLabel ?? r.sourceType}: ${truncate(r.snippet, 280)}`);
  });
  lines.push('', 'Open priorities (highest first):');
  if (ctx.tasks.length === 0) lines.push('(none)');
  for (const t of ctx.tasks) {
    lines.push(
      `- ${t.title} [${PLANNING_CATEGORY_LABELS[t.planningCategory]}, score ${Math.round(t.overallScore)}] — ${
        t.explanation ?? 'no explanation recorded'
      }`,
    );
  }
  lines.push('', 'Calendar (next 36 hours):');
  if (ctx.calendar.length === 0) lines.push('(none)');
  for (const c of ctx.calendar) {
    const attendees =
      c.participants.length > 0
        ? ` with ${c.participants
            .slice(0, 4)
            .map((p) => p.name ?? p.email ?? p.handle ?? 'someone')
            .join(', ')}`
        : '';
    lines.push(`- ${c.title} at ${c.startsAt ?? 'unknown time'}${attendees}`);
  }
  lines.push('', 'Memories about the user:');
  if (ctx.memories.length === 0) lines.push('(none)');
  for (const m of ctx.memories) lines.push(`- ${m.content}`);
  if (ctx.appliedPreferences.length > 0) {
    lines.push(
      '',
      'Learned preferences (apply these to your reply; the user can inspect and correct them):',
    );
    for (const p of ctx.appliedPreferences) {
      lines.push(`- ${p.statement} (${p.reason})`);
    }
  }
  lines.push('', 'Latest digest summary:');
  lines.push(ctx.digestSummary !== null ? truncate(ctx.digestSummary, 1500) : '(none)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Citations & suggested actions
// ---------------------------------------------------------------------------

function citationFromResult(r: SearchResult): Citation | null {
  if (r.sourceType === 'message') return null;
  return {
    sourceType: r.sourceType,
    refId: r.refId,
    title: r.title,
    sourceLabel: r.sourceLabel,
    snippet: r.snippet,
    url: r.url,
  };
}

function demoCitations(usedTasks: TaskRow[], results: SearchResult[]): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const t of usedTasks) {
    if (t.sourceItemId === null) continue;
    const key = `source_item:${t.sourceItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sourceType: 'source_item',
      refId: t.sourceItemId,
      title: t.title,
      sourceLabel: t.sourceLabel,
      snippet: t.snippet ?? t.explanation ?? undefined,
    });
  }
  for (const r of results) {
    const citation = citationFromResult(r);
    if (citation === null) continue;
    const key = `${citation.sourceType}:${citation.refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out.slice(0, 8);
}

function llmCitations(text: string, results: SearchResult[]): Citation[] {
  const referenced = new Set<number>();
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= results.length) referenced.add(n);
  }
  const chosen =
    referenced.size > 0
      ? [...referenced]
          .sort((a, b) => a - b)
          .map((n) => results[n - 1])
          .filter((r): r is SearchResult => r !== undefined)
      : results.slice(0, 5);
  return chosen
    .map((r) => citationFromResult(r))
    .filter((c): c is Citation => c !== null);
}

function extractPreferencePerson(query: string): string | null {
  const match = /treat\s+(.+?)\s+as\s+(?:important|vip)/i.exec(query);
  return match?.[1]?.trim() ?? null;
}

function buildSuggestedActions(
  tasks: TaskRow[],
  usedTasks: TaskRow[],
  query: string,
): SuggestedAction[] {
  const top = usedTasks[0] ?? tasks[0];
  const out: SuggestedAction[] = [];
  if (top !== undefined) {
    out.push({
      type: 'mark_done',
      label: `Mark done: ${truncate(top.title, 40)}`,
      payload: { taskCandidateId: top.id },
    });
    out.push({ type: 'defer', label: 'Defer to later', payload: { taskCandidateId: top.id } });
    if (top.sourceItemId !== null) {
      out.push({
        type: 'open_source',
        label: 'Open the source',
        payload: { sourceItemId: top.sourceItemId },
      });
    }
    out.push({
      type: 'ask_why',
      label: 'Why this priority?',
      payload: { taskCandidateId: top.id, title: top.title },
    });
  }
  const person = extractPreferencePerson(query);
  if (person !== null) {
    const preference: SuggestedAction = {
      type: 'add_preference',
      label: `Treat ${truncate(person, 40)} as important`,
      payload: { key: 'people.vip', person },
    };
    if (out.length >= 4) out[3] = preference;
    else out.push(preference);
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Agentic intents (conservative keyword detection)
// ---------------------------------------------------------------------------

export function detectAgentIntent(query: string): AgentIntent | null {
  const q = query.toLowerCase();
  if (/\bdraft\b/.test(q) && /\b(reply|replies|email|response|answer)\b/.test(q)) return 'draft';
  if (/\bsend\b/.test(q) && /\bemail\b/.test(q)) return 'send';
  if (/\b(schedule|invite)\b/.test(q) && /\bmeeting\b/.test(q)) return 'schedule';
  if (/\b(post|message)\b/.test(q) && /\bchannel\b/.test(q)) return 'post';
  return null;
}

function extractRecipient(query: string): string | null {
  const email = /[\w.+-]+@[\w.-]+\.\w+/.exec(query);
  if (email !== null) return email[0];
  const named = /\b(?:to|with)\s+([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)/.exec(query);
  return named?.[1] ?? null;
}

function extractTopic(query: string): string | null {
  const match = /\babout\s+(.+?)[\s?.!]*$/i.exec(query);
  return match?.[1]?.trim() ?? null;
}

function extractChannel(query: string): string | null {
  const hash = /#([a-z0-9_-]+)/i.exec(query);
  if (hash?.[1] !== undefined) return hash[1];
  const named = /\b(?:in|to|on)\s+(?:the\s+)?([a-z0-9_-]+)\s+channel/i.exec(query);
  return named?.[1] ?? null;
}

function findRelatedTask(tasks: TaskRow[], to: string | null, topic: string | null): TaskRow | null {
  const toLower = to?.toLowerCase() ?? null;
  const tokens = (topic ?? '')
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  for (const t of tasks) {
    const title = t.title.toLowerCase();
    const sender = `${t.sender?.name ?? ''} ${t.sender?.email ?? ''}`.toLowerCase();
    if (toLower !== null && toLower.length > 0 && sender.includes(toLower)) return t;
    if (tokens.some((token) => title.includes(token))) return t;
  }
  return null;
}

function composeDraftBody(
  recipient: string,
  topic: string | null,
  related: TaskRow | null,
  userName: string,
): string {
  const topicPart = topic ?? related?.title ?? 'your note';
  const contextLine =
    related !== null
      ? `On "${related.title}": ${
          related.explanation ?? related.snippet ?? 'I checked the latest status and will follow up with details shortly.'
        }`
      : 'I looked into this and will follow up with specifics shortly.';
  return [
    `Hi ${recipient},`,
    '',
    `Thanks for the note about ${topicPart}. ${contextLine}`,
    '',
    'Let me know if anything needs to move faster on your end.',
    '',
    'Best,',
    userName,
  ].join('\n');
}

export interface ConnectedAccountRef {
  id: string;
  provider: string;
  category: string;
}

/** First connected account in a category — the execution target for connector-backed actions. */
function accountFor(
  accounts: ConnectedAccountRef[],
  category: string,
): ConnectedAccountRef | null {
  return accounts.find((a) => a.category === category) ?? null;
}

async function runAgentIntent(opts: {
  actions: ActionsService;
  query: string;
  tasks: TaskRow[];
  workspaceId: string;
  userId: string;
  conversationId: string;
  userName: string;
  accounts: ConnectedAccountRef[];
}): Promise<AgentOutcome | null> {
  const intent = detectAgentIntent(opts.query);
  if (intent === null) return null;

  // Connector-backed intents need a connected account to execute against.
  const intentCategory: Record<string, string | null> = {
    draft: null,
    send: 'email',
    schedule: 'calendar',
    post: 'chat',
  };
  const neededCategory = intentCategory[intent] ?? null;
  const account = neededCategory ? accountFor(opts.accounts, neededCategory) : null;
  if (neededCategory && !account) {
    return {
      note: `I can't do that yet — you don't have a connected ${neededCategory} source that can perform this action. Connect one under Sources.`,
      approvalId: null,
    };
  }

  const to = extractRecipient(opts.query);
  const topic = extractTopic(opts.query);
  const related = findRelatedTask(opts.tasks, to, topic);
  const recipient = to ?? (related !== null ? senderName(related) : 'them');
  const subjectTopic = topic ?? related?.title ?? 'our latest discussion';
  const body = composeDraftBody(recipient, topic, related, opts.userName);
  const reason = `User asked: "${truncate(opts.query, 140)}"`;
  const base = {
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    conversationId: opts.conversationId,
    messageId: null,
    reason,
  };

  let input: ProposeActionInput;
  switch (intent) {
    case 'draft':
      input = {
        ...base,
        capability: 'draft.create',
        actionType: 'create_draft',
        params: { to: recipient, subject: `Re: ${subjectTopic}`, body },
        target: { description: `Draft reply to ${recipient}` },
        preview: { summary: `Draft a reply to ${recipient}`, body },
      };
      break;
    case 'send':
      input = {
        ...base,
        capability: 'email.send',
        actionType: 'send_email',
        params: { to: recipient, subject: `Re: ${subjectTopic}`, body },
        target: {
          provider: account?.provider,
          accountId: account?.id,
          description: `Email to ${recipient}`,
        },
        preview: { summary: `Send an email to ${recipient}`, body },
      };
      break;
    case 'schedule':
      input = {
        ...base,
        capability: 'calendar.create_invite',
        actionType: 'create_invite',
        params: { title: subjectTopic, attendees: to !== null ? [to] : [] },
        target: {
          provider: account?.provider,
          accountId: account?.id,
          description: `Calendar invite: ${subjectTopic}`,
        },
        preview: {
          summary: `Create a calendar invite for "${subjectTopic}"${to !== null ? ` with ${to}` : ''}`,
          fields: { title: subjectTopic, attendees: to ?? '(just you)' },
        },
      };
      break;
    case 'post': {
      const channel = extractChannel(opts.query) ?? 'general';
      const message =
        related !== null
          ? `Update on ${subjectTopic}: ${related.explanation ?? related.title}`
          : `Update on ${subjectTopic}.`;
      input = {
        ...base,
        capability: 'chat.post',
        actionType: 'post_message',
        params: { channel, message },
        target: {
          provider: account?.provider,
          accountId: account?.id,
          description: `Post to #${channel}`,
        },
        preview: { summary: `Post a message to #${channel}`, body: message },
      };
      break;
    }
  }

  let result;
  try {
    result = await opts.actions.propose(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      note: `I tried to set that up but hit an error: ${detail}`,
      approvalId: null,
    };
  }

  const parts: string[] = [];
  if (intent === 'draft' || intent === 'send') {
    parts.push(`Here's the draft I put together:\n\n${quoteBlock(body)}`);
  }
  if (result.approval !== null) {
    parts.push("I've queued this for your approval — see Approvals.");
  } else if (result.decision.effect === 'deny') {
    parts.push(`I couldn't proceed: your permission policy denies \`${input.capability}\`.`);
  } else if (intent === 'draft') {
    parts.push('The draft is saved locally for your review — nothing has been sent.');
  } else {
    parts.push('This was auto-approved by your policies.');
  }
  return { note: parts.join('\n\n'), approvalId: result.approval?.id ?? null };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function persistAssistantMessage(
  db: Db,
  input: {
    conversationId: string;
    workspaceId: string;
    content: string;
    citations: Citation[];
    suggestedActions: SuggestedAction[];
    status: 'complete' | 'error';
    modelUsed: string | null;
    error: string | null;
  },
): Promise<Message> {
  const id = newId('msg');
  const createdAt = nowIso();
  await db
    .insertInto('messages')
    .values({
      id,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: 'assistant',
      content: input.content,
      citations: toJson(input.citations),
      suggestedActions: toJson(input.suggestedActions),
      status: input.status,
      modelUsed: input.modelUsed,
      llmCallId: null,
      error: input.error,
      createdAt,
    })
    .execute();
  return {
    id,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    role: 'assistant',
    content: input.content,
    citations: input.citations,
    suggestedActions: input.suggestedActions,
    status: input.status,
    modelUsed: input.modelUsed,
    llmCallId: null,
    error: input.error,
    createdAt,
  };
}

async function touchConversation(
  db: Db,
  conversation: { id: string; title: string },
  firstUserContent: string,
  at: string,
): Promise<void> {
  const patch: { lastMessageAt: string; updatedAt: string; title?: string } = {
    lastMessageAt: at,
    updatedAt: at,
  };
  const title = conversation.title.trim();
  if (title === '' || title === 'New conversation') {
    patch.title = truncate(firstUserContent, 60);
  }
  await db.updateTable('conversations').set(patch).where('id', '=', conversation.id).execute();
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function createAssistantService(deps: AssistantServiceDeps): AssistantService {
  const { db, llm, memory, actions } = deps;

  return {
    async respond({ workspaceId, userId, conversationId, send, abortSignal }): Promise<Message> {
      const conversation = await db
        .selectFrom('conversations')
        .selectAll()
        .where('id', '=', conversationId)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      if (conversation === undefined) throw notFound('Conversation not found');

      const recentDesc = await db
        .selectFrom('messages')
        .selectAll()
        .where('conversationId', '=', conversationId)
        .where('workspaceId', '=', workspaceId)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .execute();
      const recent = [...recentDesc].reverse();
      const lastUser = [...recent].reverse().find((m) => m.role === 'user');
      if (lastUser === undefined) throw badRequest('No user message to respond to');
      const query = lastUser.content;
      const firstUserContent = recent.find((m) => m.role === 'user')?.content ?? query;

      try {
        const context = await assembleContext(deps, workspaceId, userId, query);
        const routed = await llm.clientForTask(workspaceId, 'chat', { conversationId }, userId);
        const user = await db
          .selectFrom('users')
          .select(['name'])
          .where('id', '=', userId)
          .executeTakeFirst();
        const userName = user?.name ?? 'there';

        // i. Memory capture (durable preference phrasing).
        let memoryNoted = false;
        if (MEMORY_TRIGGER.test(query) && (await memory.isEnabled(workspaceId))) {
          await memory.create(workspaceId, userId, {
            kind: 'preference',
            content: query,
            origin: 'inferred',
            confidence: 0.6,
            provenance: { conversationId },
          });
          memoryNoted = true;
        }
        // Self-learning: structured explicit commands ("keep replies short",
        // "x@y is high priority") become explicit preferences immediately.
        if (deps.learning !== undefined) {
          try {
            await deps.learning.learnFromText(workspaceId, userId, {
              text: query,
              refId: conversationId,
              sourceType: 'chat_message',
              observedAt: nowIso(),
            });
          } catch (err) {
            console.error('[assistant] learning capture failed', err);
          }
        }

        // h. Agentic intents go through the policy-gated actions service.
        const connectedAccounts = await db
          .selectFrom('sourceAccounts')
          .select(['id', 'provider', 'category'])
          .where('workspaceId', '=', workspaceId)
          .where('status', '=', 'connected')
          .orderBy('createdAt', 'asc')
          .execute();
        const agent = await runAgentIntent({
          actions,
          query,
          tasks: context.tasks,
          workspaceId,
          userId,
          conversationId,
          userName,
          accounts: connectedAccounts,
        });
        if (agent !== null && agent.approvalId !== null) {
          send({ type: 'approval_created', approvalId: agent.approvalId });
        }

        let text: string;
        let citations: Citation[];
        let usedTasks: TaskRow[];

        if (routed.isMock) {
          // d. Demo path: deterministic answer composed from real data.
          const demo = composeDemoAnswer(query, context);
          usedTasks = demo.usedTasks;
          const parts: string[] = [];
          if (!(agent !== null && detectDemoIntent(query) === 'overview' && demo.usedTasks.length === 0)) {
            parts.push(demo.body);
          }
          if (agent !== null) parts.push(agent.note);
          if (memoryNoted) parts.push(MEMORY_NOTE);
          parts.push(DEMO_FOOTER);
          text = parts.filter((p) => p.length > 0).join('\n\n');
          streamDemoText(text, send, abortSignal);
          citations = demoCitations(usedTasks, context.results);
        } else {
          // e. LLM path: persona prompt + numbered context + conversation turns.
          const messages: LlmMessage[] = [
            { role: 'system', content: buildSystemPrompt(userName, context.responseStyle, new Date()) },
            { role: 'user', content: buildContextBlock(context) },
            ...recent
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m): LlmMessage => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          ];
          let streamed = '';
          let streamError: string | null = null;
          const stream = routed.client.chatStream(
            {
              model: routed.model,
              messages,
              temperature: routed.params.temperature,
              maxTokens: routed.params.maxTokens,
              abortSignal,
            },
            'chat',
          );
          for await (const event of stream) {
            if (event.type === 'delta') {
              streamed += event.text;
              send({ type: 'delta', text: event.text });
            } else if (event.type === 'error') {
              streamError = event.error;
            }
          }
          if (streamError !== null) {
            const content =
              streamed.length > 0
                ? `${streamed}\n\n_I lost the connection to the model before finishing — the answer above may be incomplete._`
                : 'I could not reach the configured AI model. Check Settings → AI Providers, or try again in a moment.';
            const message = await persistAssistantMessage(db, {
              conversationId,
              workspaceId,
              content,
              citations: [],
              suggestedActions: [],
              status: 'error',
              modelUsed: routed.model,
              error: streamError,
            });
            await touchConversation(db, conversation, firstUserContent, message.createdAt);
            send({ type: 'error', error: streamError });
            return message;
          }
          const extras: string[] = [];
          if (agent !== null) extras.push(agent.note);
          if (memoryNoted) extras.push(MEMORY_NOTE);
          text = streamed;
          if (extras.length > 0) {
            const tail = `\n\n${extras.join('\n\n')}`;
            text += tail;
            send({ type: 'delta', text: tail });
          }
          citations = llmCitations(streamed, context.results);
          usedTasks = context.tasks.filter(
            (t) => t.sourceItemId !== null && citations.some((c) => c.refId === t.sourceItemId),
          );
        }

        // f + g. Citations and deterministic suggested actions.
        send({ type: 'citations', citations });
        const suggestedActions = buildSuggestedActions(context.tasks, usedTasks, query);
        send({ type: 'actions', actions: suggestedActions });

        // j. Persist + finalize.
        const message = await persistAssistantMessage(db, {
          conversationId,
          workspaceId,
          content: text,
          citations,
          suggestedActions,
          status: 'complete',
          modelUsed: routed.model,
          error: null,
        });
        await touchConversation(db, conversation, firstUserContent, message.createdAt);
        send({ type: 'message', message });
        return message;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const message = await persistAssistantMessage(db, {
          conversationId,
          workspaceId,
          content: FRIENDLY_ERROR,
          citations: [],
          suggestedActions: [],
          status: 'error',
          modelUsed: null,
          error: detail,
        });
        await touchConversation(db, conversation, firstUserContent, message.createdAt);
        send({ type: 'error', error: detail });
        return message;
      }
    },
  };
}
