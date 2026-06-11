/**
 * Signal extraction: turns normalized content and user actions into
 * LearningSignalInput records. Deterministic and pure — all time math is
 * relative to `ctx.now`, no IO.
 *
 * Revealed-preference theory drives the design: most extractors observe what
 * the user DOES (replies, ignores, edits, approves) rather than what the
 * content says. Affect markers are extracted with deliberately low strength.
 */
import type { PersonRef } from '../entities.js';
import type { FeedbackKind, SourceCategory } from '../enums.js';
import { analyzeDraftEdit, analyzeWritingStyle } from './style.js';
import type {
  AudienceKind,
  LearningSignalInput,
  LearningScope,
  SignalSource,
} from './types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------- Inputs ----------

/** The subset of a normalized source item the extractors need. */
export interface LearnableItem {
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
  threadExternalId: string | null;
  isRead: number;
}

/** What the extractor knows about a correspondent (from the people table). */
export interface PersonContext {
  email: string;
  importance: 'vip' | 'high' | 'normal' | 'low' | 'ignore';
  title: string | null;
}

export interface ExtractionContext {
  now: string;
  /** The user's own email addresses (lowercased). */
  selfEmails: string[];
  /** Domains of the user's own work addresses (lowercased). */
  selfDomains: string[];
  /** Known people keyed by lowercased email. */
  people: Record<string, PersonContext>;
}

// ---------- Audience classification ----------

const LEADERSHIP_TITLE_RE =
  /\b(ceo|cto|cfo|coo|chief|vp|vice president|president|director|head of|founder|board)\b/i;
const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

/**
 * Bucket a correspondent into an audience (politeness theory: style is
 * learned per audience, never globally). Heuristic and conservative —
 * 'unknown' when there is no email to go on.
 */
export function classifyAudience(email: string | undefined, ctx: ExtractionContext): AudienceKind {
  if (email === undefined || email === '') return 'unknown';
  const lower = email.toLowerCase();
  const person = ctx.people[lower];
  if (person?.title !== null && person?.title !== undefined && LEADERSHIP_TITLE_RE.test(person.title)) {
    return 'leadership';
  }
  if (person?.importance === 'vip') return 'leadership';
  const domain = emailDomain(lower);
  if (domain !== '' && ctx.selfDomains.includes(domain)) return 'team';
  if (FREEMAIL_DOMAINS.has(domain)) return 'personal';
  return 'external';
}

function isSelf(ref: PersonRef | null | undefined, ctx: ExtractionContext): boolean {
  const email = ref?.email?.toLowerCase();
  return email !== undefined && ctx.selfEmails.includes(email);
}

/** Primary non-self recipient of an outgoing item. */
function primaryRecipient(item: LearnableItem, ctx: ExtractionContext): PersonRef | undefined {
  return item.participants.find((p) => !isSelf(p, ctx) && p.email !== undefined && p.email !== '');
}

// ---------- Topic helpers ----------

const TOPIC_STOPWORDS = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'this', 'that', 'with',
  'from', 'have', 'will', 'your', 'please', 'update', 'reminder', 'meeting',
  'today', 'tomorrow', 'need', 'needs', 'them', 'they', 'over', 'into', 'what',
  'when', 'where', 'fwd', 'thread', 'urgent', 'quick', 'question', 'subject',
]);

/** First meaningful keyword of a title — the stable topic bucket for aggregation. */
export function topicSlug(title: string): string | null {
  const words = title
    .toLowerCase()
    .replace(/^(re|fwd?|fw):\s*/i, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !TOPIC_STOPWORDS.has(w));
  return words[0] ?? null;
}

// ---------- Lexical matchers ----------

// Prospect theory: loss/risk framing tends to outweigh equivalent upside.
const LOSS_FRAME_RE =
  /\b(risk|lose|losing|lost|churn|cancel(?:ling|lation)?|penalt\w*|breach|outage|escalat\w*|miss(?:ed|ing)? the deadline|reputation|complaint|refund|downtime|blocker)\b/i;

// Goal-setting theory: explicit goal language.
const GOAL_RE =
  /\b(goal is|our goal|aim(?:ing)? to|target(?:ing)?\s+(?:is|to)|we need to ship|must (?:launch|ship|close|finish|deliver)|by end of (?:quarter|month|year|q[1-4])|okrs?\b)\b/i;
const BLOCKED_RE = /\b(blocked on|blocked by|waiting on|stuck on|can'?t proceed|held up by)\b/i;

const COMMITMENT_RE =
  /\bi(?:'ll| will)\s+(send|share|get back|review|update|follow up|circulate|draft|schedule|prepare|confirm)\b/i;

const DELEGATION_RE =
  /\b(can you (?:take|handle|own|drive)|please (?:take this|handle|own|drive)|delegat\w+|over to you|assigning this to|you run with)\b/i;

const FRUSTRATION_RE =
  /\b(frustrat\w*|annoy\w*|disappoint\w*|this is still (?:broken|not working)|yet again|third time)\b/i;
const ENTHUSIASM_RE = /\b(love (?:this|it)|excited|fantastic|brilliant|great work|awesome)\b/i;

function itemText(item: LearnableItem): string {
  return `${item.title}\n${item.bodyText ?? item.snippet ?? ''}`;
}

function sourceOf(item: LearnableItem, note?: string): SignalSource {
  const source: SignalSource = { sourceType: 'source_item', refId: item.id, observedAt: item.itemTimestamp };
  if (note !== undefined) source.note = note;
  return source;
}

// ---------- Extractor: a single item ----------

/**
 * Extract signals from one item. For SELF-AUTHORED items this yields writing
 * style (per audience), goals, commitments, delegation, and coarse sentiment.
 * Incoming items yield nothing here — what the user *does* with them is
 * captured by extractThreadReplySignals (revealed preference over content).
 */
export function extractItemSignals(
  item: LearnableItem,
  ctx: ExtractionContext,
): LearningSignalInput[] {
  if (!isSelf(item.sender, ctx)) return [];
  if (item.category !== 'email' && item.category !== 'chat') return [];

  const signals: LearningSignalInput[] = [];
  const text = itemText(item);
  const recipient = primaryRecipient(item, ctx);
  const audience = classifyAudience(recipient?.email, ctx);
  const scope: LearningScope = { audience, channel: item.category };
  const observedAt = item.itemTimestamp;

  // Writing style, scoped by audience (communication accommodation theory).
  const style = analyzeWritingStyle(item.bodyText ?? item.snippet ?? '');
  const styleSignal = (key: string, value: string, note: string): void => {
    signals.push({
      kind: 'writing_style',
      key,
      value,
      strength: 0.5,
      scope,
      detail: note,
      source: sourceOf(item, note),
      observedAt,
    });
  };
  const audienceLabel = audience === 'unknown' ? 'a contact' : `a ${audience} contact`;
  if (style.length !== null) {
    styleSignal('style.length', style.length, `Wrote a ${style.length} message (${style.wordCount} words) to ${audienceLabel}`);
  }
  if (style.directness !== null) {
    styleSignal('style.directness', style.directness, `Used a ${style.directness} tone (${style.hedgeCount} hedges) with ${audienceLabel}`);
  }
  if (style.formality !== null) {
    styleSignal('style.formality', style.formality, `Wrote in a ${style.formality} register to ${audienceLabel}`);
  }
  if (style.structure === 'bullets') {
    styleSignal('format.structure', 'bullets', `Structured a message to ${audienceLabel} as bullet points`);
  }

  const slug = topicSlug(item.title);

  // Goal-setting theory: explicit goals; blocked goals are tracked distinctly.
  if (GOAL_RE.test(text) && slug !== null) {
    const blocked = BLOCKED_RE.test(text);
    const note = blocked
      ? `Mentioned a blocked goal around "${slug}"`
      : `Stated a goal around "${slug}"`;
    signals.push({
      kind: 'goal',
      key: `goal.topic:${slug}`,
      value: blocked ? 'blocked' : 'active',
      strength: 0.4,
      scope: {},
      detail: note,
      source: sourceOf(item, note),
      observedAt,
    });
  }

  const commitment = COMMITMENT_RE.exec(text);
  if (commitment !== null) {
    const note = `Committed to "${commitment[0].toLowerCase()}"${slug !== null ? ` re: ${slug}` : ''}`;
    signals.push({
      kind: 'commitment',
      key: 'commitment',
      value: 'made',
      strength: 0.3,
      scope: {},
      detail: note,
      source: sourceOf(item, note),
      observedAt,
    });
  }

  if (DELEGATION_RE.test(text)) {
    const note = 'Delegated a task in a message';
    signals.push({
      kind: 'delegation',
      key: 'workflow.delegation',
      value: 'delegates',
      strength: 0.3,
      scope: { audience },
      detail: note,
      source: sourceOf(item, note),
      observedAt,
    });
  }

  // Affective computing: coarse valence only, low strength, never certainty.
  if (slug !== null) {
    if (FRUSTRATION_RE.test(text)) {
      const note = `Expressed frustration in a message about "${slug}"`;
      signals.push({
        kind: 'sentiment',
        key: `topic.sentiment:${slug}`,
        value: 'negative',
        strength: 0.2,
        scope: {},
        detail: note,
        source: sourceOf(item, note),
        observedAt,
      });
    } else if (ENTHUSIASM_RE.test(text)) {
      const note = `Expressed enthusiasm in a message about "${slug}"`;
      signals.push({
        kind: 'sentiment',
        key: `topic.sentiment:${slug}`,
        value: 'positive',
        strength: 0.2,
        scope: {},
        detail: note,
        source: sourceOf(item, note),
        observedAt,
      });
    }
  }

  return signals;
}

// ---------- Extractor: thread reply behavior ----------

const FAST_REPLY_MS = 2 * HOUR_MS;
const REPLY_WINDOW_MS = 24 * HOUR_MS;
const IGNORE_AFTER_MS = 4 * DAY_MS;

/**
 * Revealed preference over a window of items: who the user answers fast,
 * who they ignore, and whether loss-framed content gets faster attention.
 * Operates on email/chat threads grouped by threadExternalId.
 */
export function extractThreadReplySignals(
  items: LearnableItem[],
  ctx: ExtractionContext,
): LearningSignalInput[] {
  const signals: LearningSignalInput[] = [];
  const threads = new Map<string, LearnableItem[]>();
  for (const item of items) {
    if (item.category !== 'email' && item.category !== 'chat') continue;
    if (item.threadExternalId === null || item.threadExternalId === '') continue;
    const key = `${item.category}:${item.threadExternalId}`;
    const list = threads.get(key) ?? [];
    list.push(item);
    threads.set(key, list);
  }

  const nowMs = Date.parse(ctx.now);

  for (const thread of threads.values()) {
    thread.sort((a, b) => a.itemTimestamp.localeCompare(b.itemTimestamp));
    for (let i = 0; i < thread.length; i += 1) {
      const incoming = thread[i];
      if (incoming === undefined || isSelf(incoming.sender, ctx)) continue;
      const senderEmail = incoming.sender?.email?.toLowerCase();
      if (senderEmail === undefined || senderEmail === '') continue;

      const reply = thread
        .slice(i + 1)
        .find((t) => isSelf(t.sender, ctx) && t.itemTimestamp > incoming.itemTimestamp);
      const incomingMs = Date.parse(incoming.itemTimestamp);
      const slug = topicSlug(incoming.title);

      if (reply !== undefined) {
        const latencyMs = Date.parse(reply.itemTimestamp) - incomingMs;
        const fast = latencyMs <= FAST_REPLY_MS;
        const withinDay = latencyMs <= REPLY_WINDOW_MS;
        const latencyLabel = fast
          ? `within ${Math.max(1, Math.round(latencyMs / 60000))} minutes`
          : withinDay
            ? `within ${Math.round(latencyMs / HOUR_MS)} hours`
            : `after ${Math.round(latencyMs / DAY_MS)} days`;
        const note = `Replied ${latencyLabel} to ${senderEmail}`;
        signals.push({
          kind: 'reply_behavior',
          key: `person.priority:${senderEmail}`,
          value: 'high',
          strength: fast ? 0.6 : withinDay ? 0.35 : 0.15,
          scope: {},
          detail: note,
          source: sourceOf(reply, note),
          observedAt: reply.itemTimestamp,
        });

        if (fast && slug !== null) {
          const topicNote = `Replied quickly to a message about "${slug}"`;
          signals.push({
            kind: 'topic_engagement',
            key: `topic.priority:${slug}`,
            value: 'high',
            strength: 0.3,
            scope: {},
            detail: topicNote,
            source: sourceOf(reply, topicNote),
            observedAt: reply.itemTimestamp,
          });
        }

        // Prospect theory: fast engagement with loss-framed content.
        if (fast && LOSS_FRAME_RE.test(itemText(incoming))) {
          const riskNote = `Replied quickly to a risk/loss-framed message ("${incoming.title.slice(0, 60)}")`;
          signals.push({
            kind: 'loss_frame',
            key: 'risk.attention',
            value: 'prioritizes_risk',
            strength: 0.5,
            scope: {},
            detail: riskNote,
            source: sourceOf(reply, riskNote),
            observedAt: reply.itemTimestamp,
          });
        }
      } else if (
        Number.isFinite(incomingMs) &&
        nowMs - incomingMs > IGNORE_AFTER_MS &&
        incoming.participants.some((p) => isSelf(p, ctx))
      ) {
        // Addressed directly, never answered: weak "ignores" evidence.
        const note = `No reply to ${senderEmail} after ${Math.round((nowMs - incomingMs) / DAY_MS)} days`;
        signals.push({
          kind: 'reply_behavior',
          key: `person.priority:${senderEmail}`,
          value: 'low',
          strength: 0.25,
          scope: {},
          detail: note,
          source: sourceOf(incoming, note),
          observedAt: incoming.itemTimestamp,
        });
      }
    }
  }

  return signals;
}

// ---------- Extractor: calendar density ----------

const DENSE_DAY_EVENTS = 6;

/** Cognitive load theory: dense days are an overload signal (context, not trait). */
export function extractCalendarDensitySignals(
  items: LearnableItem[],
  _ctx: ExtractionContext,
): LearningSignalInput[] {
  const byDay = new Map<string, LearnableItem[]>();
  for (const item of items) {
    if (item.category !== 'calendar' || item.startsAt === null) continue;
    const day = item.startsAt.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(item);
    byDay.set(day, list);
  }
  const signals: LearningSignalInput[] = [];
  for (const [day, events] of byDay) {
    const firstEvent = events[0];
    if (firstEvent === undefined || events.length < DENSE_DAY_EVENTS) continue;
    const note = `${events.length} meetings on ${day}`;
    signals.push({
      kind: 'calendar_density',
      key: 'schedule.load',
      value: 'overloaded',
      strength: 0.3,
      scope: { channel: 'calendar' },
      detail: note,
      source: sourceOf(firstEvent, note),
      observedAt: `${day}T00:00:00.000Z`,
    });
  }
  return signals;
}

// ---------- Extractor: explicit item feedback ----------

export interface FeedbackObservation {
  kind: FeedbackKind;
  senderEmail?: string;
  itemTitle?: string;
  feedbackId: string;
  observedAt: string;
}

/** Explicit feedback outweighs passive inference — these signals carry high strength. */
export function extractFeedbackSignals(obs: FeedbackObservation): LearningSignalInput[] {
  const signals: LearningSignalInput[] = [];
  const source: SignalSource = {
    sourceType: 'item_feedback',
    refId: obs.feedbackId,
    observedAt: obs.observedAt,
  };
  const slug = obs.itemTitle !== undefined ? topicSlug(obs.itemTitle) : null;
  const email = obs.senderEmail?.toLowerCase();

  const push = (key: string, value: string, strength: number, detail: string): void => {
    signals.push({
      kind: 'feedback',
      key,
      value,
      strength,
      scope: {},
      detail,
      source: { ...source, note: detail },
      observedAt: obs.observedAt,
    });
  };

  switch (obs.kind) {
    case 'important':
      if (email !== undefined && email !== '') {
        push(`person.priority:${email}`, 'high', 0.8, `Marked a message from ${email} as important`);
      }
      if (slug !== null) push(`topic.priority:${slug}`, 'high', 0.5, `Marked an item about "${slug}" as important`);
      break;
    case 'not_important':
      if (email !== undefined && email !== '') {
        push(`person.priority:${email}`, 'low', 0.8, `Marked a message from ${email} as not important`);
      }
      if (slug !== null) push(`topic.priority:${slug}`, 'low', 0.5, `Marked an item about "${slug}" as not important`);
      break;
    case 'urgent':
      if (slug !== null) push(`topic.priority:${slug}`, 'high', 0.4, `Marked an item about "${slug}" as urgent`);
      break;
    case 'not_urgent':
      if (slug !== null) push(`topic.priority:${slug}`, 'low', 0.3, `Marked an item about "${slug}" as not urgent`);
      break;
    case 'more_like_this':
      if (slug !== null) push(`topic.priority:${slug}`, 'high', 0.6, `Asked for more items like "${slug}"`);
      break;
    default:
      break; // done / deferred / incorrect carry no preference vote
  }
  return signals;
}

// ---------- Extractor: agent action decisions ----------

export interface ActionDecisionObservation {
  capability: string;
  decision: 'approved' | 'denied';
  refId: string;
  observedAt: string;
}

/** Approve/deny on proposed actions is a deliberate, revealed trust decision. */
export function extractActionDecisionSignal(obs: ActionDecisionObservation): LearningSignalInput {
  const note = `${obs.decision === 'approved' ? 'Approved' : 'Denied'} a proposed '${obs.capability}' action`;
  return {
    kind: 'action_decision',
    key: `action.trust:${obs.capability}`,
    value: obs.decision,
    strength: 0.5,
    scope: {},
    detail: note,
    source: { sourceType: 'agent_action', refId: obs.refId, observedAt: obs.observedAt, note },
    observedAt: obs.observedAt,
  };
}

// ---------- Extractor: draft edits ----------

export interface DraftEditInput {
  original: string;
  edited: string;
  audience: AudienceKind;
  channel?: SourceCategory;
  refId?: string;
  observedAt: string;
}

/** User edits to AI drafts are strong revealed style preference (strength 0.7). */
export function extractDraftEditSignals(input: DraftEditInput): LearningSignalInput[] {
  const { changes } = analyzeDraftEdit(input.original, input.edited);
  const scope: LearningScope = { audience: input.audience };
  if (input.channel !== undefined) scope.channel = input.channel;
  return changes.map((change) => {
    const key =
      change.dimension === 'structure' ? 'format.structure' : `style.${change.dimension}`;
    const source: SignalSource = {
      sourceType: 'draft_edit',
      observedAt: input.observedAt,
      note: change.note,
    };
    if (input.refId !== undefined) source.refId = input.refId;
    return {
      kind: 'writing_style' as const,
      key,
      value: change.to,
      strength: 0.7,
      scope,
      detail: change.note,
      source,
      observedAt: input.observedAt,
    };
  });
}

// ---------- Extractor: explicit preference statements ----------

interface ExplicitTemplate {
  re: RegExp;
  key: string | ((m: RegExpExecArray) => string | null);
  value: string;
  detail: string;
}

const EXPLICIT_TEMPLATES: ExplicitTemplate[] = [
  {
    re: /\b(?:keep (?:it|emails?|replies|summaries|messages)|make (?:it|them)|prefer|be more) (?:short(?:er)?|brief|concise)\b/i,
    key: 'style.length',
    value: 'concise',
    detail: 'Asked for concise output',
  },
  {
    re: /\b(?:prefer|want|give me|add) more (?:detail|context|depth)\b|\bbe more detailed\b/i,
    key: 'style.length',
    value: 'detailed',
    detail: 'Asked for more detailed output',
  },
  {
    re: /\b(?:use|prefer|with) bullet points?\b/i,
    key: 'format.structure',
    value: 'bullets',
    detail: 'Asked for bullet-point structure',
  },
  {
    re: /\bbe (?:more )?direct\b|\bprefer direct\b|\bless verbose\b|\bget to the point\b/i,
    key: 'style.directness',
    value: 'direct',
    detail: 'Asked for a direct tone',
  },
  {
    re: /\b(?:be|sound|keep it) (?:more )?formal\b/i,
    key: 'style.formality',
    value: 'formal',
    detail: 'Asked for a formal register',
  },
  {
    re: /\b(?:be|sound|keep it) (?:more )?casual\b/i,
    key: 'style.formality',
    value: 'casual',
    detail: 'Asked for a casual register',
  },
  {
    re: /\b([\w.+-]+@[\w.-]+\.\w+) is (?:very |really )?(?:high priority|important|a vip)\b/i,
    key: (m) => (m[1] === undefined ? null : `person.priority:${m[1].toLowerCase()}`),
    value: 'high',
    detail: 'Said this person is high priority',
  },
  {
    re: /\b(?:ignore|mute|deprioritize) (?:emails? from )?([\w.+-]+@[\w.-]+\.\w+)\b/i,
    key: (m) => (m[1] === undefined ? null : `person.priority:${m[1].toLowerCase()}`),
    value: 'low',
    detail: 'Asked to deprioritize this person',
  },
  {
    re: /\b(?:the )?([a-z][a-z0-9-]{3,30}) (?:project |topic )?is (?:my |our )?(?:top|high) priority\b/i,
    key: (m) => {
      const slug = m[1]?.toLowerCase();
      return slug === undefined || TOPIC_STOPWORDS.has(slug) ? null : `topic.priority:${slug}`;
    },
    value: 'high',
    detail: 'Said this topic is high priority',
  },
  {
    re: /\b(?:i )?(?:don'?t care about|ignore|stop showing|not interested in) (?:the )?([a-z][a-z0-9-]{3,30})\b/i,
    key: (m) => {
      const slug = m[1]?.toLowerCase();
      return slug === undefined || TOPIC_STOPWORDS.has(slug) ? null : `topic.priority:${slug}`;
    },
    value: 'low',
    detail: 'Asked to ignore this topic',
  },
];

export interface ExplicitStatementInput {
  text: string;
  refId?: string;
  sourceType?: 'chat_message' | 'user_command';
  observedAt: string;
}

/**
 * Parse explicit preference commands ("keep replies short", "x@y.com is high
 * priority"). Only structured matches become signals — free-form statements
 * are the memory service's job. Explicit signals carry maximum strength.
 */
export function extractExplicitStatementSignals(
  input: ExplicitStatementInput,
): LearningSignalInput[] {
  const signals: LearningSignalInput[] = [];
  for (const template of EXPLICIT_TEMPLATES) {
    const match = template.re.exec(input.text);
    if (match === null) continue;
    const key = typeof template.key === 'function' ? template.key(match) : template.key;
    if (key === null) continue;
    const source: SignalSource = {
      sourceType: input.sourceType ?? 'chat_message',
      observedAt: input.observedAt,
      note: `${template.detail}: "${match[0].trim()}"`,
    };
    if (input.refId !== undefined) source.refId = input.refId;
    signals.push({
      kind: 'explicit_statement',
      key,
      value: template.value,
      strength: 1,
      scope: {},
      detail: source.note ?? null,
      source,
      observedAt: input.observedAt,
    });
  }
  return signals;
}
