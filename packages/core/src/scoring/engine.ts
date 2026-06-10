/**
 * Deterministic priority scoring engine.
 *
 * Rules-first by design: this module must produce useful, explainable scores
 * with NO LLM configured. An optional LLM refinement can be merged on top via
 * `applyRefinement`, but its influence is clamped.
 *
 * Pure: never reads the wall clock — all time math is relative to `ctx.now`.
 * Every rule that fires appends a ScoreSignal so the UI can show "why".
 */
import type { ScoreSignal } from '../entities.js';
import type { Level, PlanningCategory } from '../enums.js';
import type {
  FeedbackSignal,
  LlmScoreRefinement,
  PersonSignal,
  PriorityScore,
  ScorableItem,
  ScoringContext,
} from './types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const IMPORTANCE_BASE = 30;
const URGENCY_BASE = 30;
const EFFORT_BASE = 20;

const REFINEMENT_DELTA_LIMIT = 15;

// --- keyword matchers (case-insensitive over title + body + snippet) ---
const ESCALATION_RE = /escalat|urgent|critical|blocker|blocked|asap/i;
const DEADLINE_RE = /\b(?:deadline|due|by friday|by eod|eow)\b/i;
const BLOCKING_RE = /blocked on you|waiting on you|need your/i;
const TIME_SENSITIVE_RE = /\b(?:asap|eod|end of day|today|right away|immediately)\b/i;
const PREP_RE = /prepare|draft|review|write up|put together|analysis|deck/i;
const COORDINATION_RE = /coordinate|align|schedule with|loop in|external/i;
const DECISION_RE = /approve|decision|sign.?off|choose|confirm by/i;
const WAITING_ON_RE = /waiting on|waiting for/i;
const LONG_FORM_RE = /newsletter|unsubscribe|roundup|weekly update|digest/i;

const SENDER_IMPORTANCE_WEIGHTS: Record<PersonSignal['importance'], number> = {
  vip: 30,
  high: 18,
  normal: 0,
  low: -15,
  ignore: -40,
};

const SENDER_DESCRIPTORS: Record<PersonSignal['importance'], string> = {
  vip: 'key stakeholder',
  high: 'important contact',
  normal: 'contact',
  low: 'low-priority contact',
  ignore: 'muted contact',
};

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Map a 0-100 score onto a discrete level. */
export function toLevel(score: number): Level {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function upperFirst(s: string): string {
  return s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  return s === '' ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function findPerson(
  ref: ScorableItem['sender'],
  people: PersonSignal[],
): PersonSignal | undefined {
  if (!ref) return undefined;
  const email = ref.email?.toLowerCase();
  const handle = ref.handle;
  return people.find(
    (p) =>
      (ref.personId !== undefined && ref.personId === p.personId) ||
      (email !== undefined && p.emails.some((e) => e.toLowerCase() === email)) ||
      (handle !== undefined && handle !== '' && p.handles.includes(handle)),
  );
}

type Dimension = 'importance' | 'urgency' | 'effort';

/** Score one item against the user's context. Deterministic for a fixed (item, ctx). */
export function scoreItem(item: ScorableItem, ctx: ScoringContext): PriorityScore {
  const signals: ScoreSignal[] = [];
  const totals: Record<Dimension, number> = {
    importance: IMPORTANCE_BASE,
    urgency: URGENCY_BASE,
    effort: EFFORT_BASE,
  };

  const add = (dim: Dimension, key: string, label: string, weight: number, detail?: string): void => {
    const signal: ScoreSignal = { key: `${dim}.${key}`, label, weight };
    if (detail !== undefined) signal.detail = detail;
    signals.push(signal);
    totals[dim] += weight;
  };

  const text = `${item.title}\n${item.bodyText ?? ''}\n${item.snippet ?? ''}`.toLowerCase();
  const nowMs = Date.parse(ctx.now);
  const itemTsMs = Date.parse(item.itemTimestamp);
  const bodyLen = item.bodyLength ?? item.bodyText?.length ?? 0;
  const senderEmail = item.sender?.email?.toLowerCase();

  // ======================= IMPORTANCE =======================
  const senderPerson = findPerson(item.sender, ctx.people);
  if (senderPerson) {
    const weight = SENDER_IMPORTANCE_WEIGHTS[senderPerson.importance];
    if (weight !== 0) {
      add(
        'importance',
        `sender_${senderPerson.importance}`,
        `Sender importance: ${senderPerson.importance}`,
        weight,
        `from ${senderPerson.displayName} (${SENDER_DESCRIPTORS[senderPerson.importance]})`,
      );
    }
    if (senderPerson.interactionCount >= 20) {
      add(
        'importance',
        'frequent_contact',
        'Frequent contact',
        6,
        `${senderPerson.displayName} is a frequent contact`,
      );
    }
  }

  const selfEmails = ctx.selfEmails.map((e) => e.toLowerCase()).filter((e) => e !== '');
  const addressedViaParticipants =
    item.category === 'email' &&
    item.participants.some((p) => {
      const e = p.email?.toLowerCase();
      return e !== undefined && selfEmails.includes(e);
    });
  const addressedViaMention = selfEmails.some((e) => text.includes(e));
  const directlyAddressed = addressedViaParticipants || addressedViaMention;
  if (directlyAddressed) {
    add('importance', 'directly_addressed', 'Directly addressed to you', 8, 'addressed to you directly');
  }

  const project = ctx.projects.find((p) =>
    [p.name, ...p.keywords].some((k) => k !== '' && text.includes(k.toLowerCase())),
  );
  if (project) {
    add('importance', 'project_match', 'Active project', 15, `relates to ${project.name}`);
    if (project.priority === 'high') {
      add(
        'importance',
        'project_priority_high',
        'High-priority project',
        8,
        `${project.name} is a high-priority project`,
      );
    }
  }

  const topicHit = ctx.preferences.topicsPrioritize.find(
    (t) => t !== '' && text.includes(t.toLowerCase()),
  );
  if (topicHit !== undefined) {
    add(
      'importance',
      'topic_prioritized',
      'Prioritized topic',
      15,
      `matches a topic you prioritize ("${topicHit}")`,
    );
  }
  const topicIgnored = ctx.preferences.topicsIgnore.find(
    (t) => t !== '' && text.includes(t.toLowerCase()),
  );
  if (topicIgnored !== undefined) {
    add(
      'importance',
      'topic_ignored',
      'Ignored topic',
      -25,
      `matches a topic you ignore ("${topicIgnored}")`,
    );
  }

  const providerLower = item.provider.toLowerCase();
  if (ctx.preferences.sourcesPrioritize.some((s) => s.toLowerCase() === providerLower)) {
    add(
      'importance',
      'source_prioritized',
      'Prioritized source',
      10,
      `from a source you prioritize (${item.provider})`,
    );
  }
  if (ctx.preferences.sourcesIgnore.some((s) => s.toLowerCase() === providerLower)) {
    add(
      'importance',
      'source_ignored',
      'Ignored source',
      -20,
      `from a source you ignore (${item.provider})`,
    );
  }

  const hasEscalation = ESCALATION_RE.test(text);
  if (hasEscalation) {
    add('importance', 'escalation', 'Escalation language', 10, 'contains escalation language');
  }
  if (DEADLINE_RE.test(text)) {
    add('importance', 'deadline_language', 'Mentions a deadline', 8, 'mentions a deadline');
  }
  const blocksOthers = BLOCKING_RE.test(text);
  if (blocksOthers) {
    add('importance', 'blocking_others', 'Blocking others', 12, 'someone is waiting on you');
  }

  const feedbackMatches = (f: FeedbackSignal): boolean => {
    if (f.senderEmail !== undefined && senderEmail !== undefined) {
      if (f.senderEmail.toLowerCase() === senderEmail) return true;
    }
    return (f.keywords ?? []).some((k) => k !== '' && text.includes(k.toLowerCase()));
  };
  if (
    ctx.feedback.some(
      (f) => (f.kind === 'important' || f.kind === 'more_like_this') && feedbackMatches(f),
    )
  ) {
    add(
      'importance',
      'feedback_important',
      'Marked important before',
      10,
      'you marked similar items important',
    );
  }
  if (ctx.feedback.some((f) => f.kind === 'not_important' && feedbackMatches(f))) {
    add(
      'importance',
      'feedback_not_important',
      'Marked not important before',
      -15,
      'you marked similar items not important',
    );
  }

  // ======================= URGENCY =======================
  const dueMs = item.dueAt !== null && item.dueAt !== undefined ? Date.parse(item.dueAt) : Number.NaN;
  if (!Number.isNaN(dueMs) && !Number.isNaN(nowMs)) {
    const untilDue = dueMs - nowMs;
    if (untilDue < 0) {
      add('urgency', 'overdue', 'Overdue', 45, 'already overdue');
    } else if (untilDue < 4 * HOUR_MS) {
      add('urgency', 'due_within_4h', 'Due very soon', 40, 'due within 4 hours');
    } else if (untilDue < 24 * HOUR_MS) {
      add(
        'urgency',
        'due_within_24h',
        'Due within a day',
        32,
        utcDay(dueMs) === utcDay(nowMs + DAY_MS) ? 'due tomorrow' : 'due today',
      );
    } else if (untilDue < 72 * HOUR_MS) {
      add('urgency', 'due_within_72h', 'Due within three days', 18, 'due within three days');
    }
  }

  let meetingStartMs = Number.NaN;
  if (item.category === 'calendar' && item.startsAt !== null && item.startsAt !== undefined) {
    const startMs = Date.parse(item.startsAt);
    if (!Number.isNaN(startMs) && !Number.isNaN(nowMs)) {
      meetingStartMs = startMs;
      const untilStart = startMs - nowMs;
      if (untilStart >= 0 && untilStart < 4 * HOUR_MS) {
        add('urgency', 'meeting_within_4h', 'Meeting starts soon', 40, 'meeting starts within 4 hours');
      } else if (untilStart >= 0 && utcDay(startMs) === utcDay(nowMs)) {
        add('urgency', 'meeting_today', 'Meeting today', 30, 'meeting today');
      } else if (utcDay(startMs) === utcDay(nowMs + DAY_MS)) {
        add('urgency', 'meeting_tomorrow', 'Meeting tomorrow', 15, 'meeting tomorrow');
      }
    }
  }

  if (TIME_SENSITIVE_RE.test(text)) {
    add('urgency', 'time_sensitive', 'Time-sensitive wording', 15, 'uses time-sensitive wording');
  }

  const ageMs = !Number.isNaN(nowMs) && !Number.isNaN(itemTsMs) ? nowMs - itemTsMs : Number.NaN;
  if (item.isRead === 0 && !Number.isNaN(ageMs) && ageMs >= 0 && ageMs < 24 * HOUR_MS) {
    add('urgency', 'unread_recent', 'Unread and recent', 8, 'unread and arrived in the last day');
  }

  const staleDays = Number.isNaN(ageMs) ? 0 : Math.max(0, Math.floor(ageMs / DAY_MS));
  const staleAwaiting =
    (item.category === 'email' || item.category === 'chat') &&
    !Number.isNaN(ageMs) &&
    ageMs > 3 * DAY_MS &&
    (item.bodyText ?? '').includes('?');
  if (staleAwaiting) {
    add(
      'urgency',
      'stale_awaiting_reply',
      'Stale thread awaiting a reply',
      12,
      `awaiting a reply for ${staleDays} days`,
    );
  }

  if (hasEscalation) {
    add('urgency', 'escalation', 'Escalation language', 10, 'escalation language raises urgency');
  }

  if (ctx.feedback.some((f) => f.kind === 'urgent' && feedbackMatches(f))) {
    add('urgency', 'feedback_urgent', 'Marked urgent before', 12, 'you marked similar items urgent');
  }
  if (ctx.feedback.some((f) => f.kind === 'not_urgent' && feedbackMatches(f))) {
    add(
      'urgency',
      'feedback_not_urgent',
      'Marked not urgent before',
      -15,
      'you marked similar items not urgent',
    );
  }

  // ======================= EFFORT =======================
  if (bodyLen > 4000) {
    add('effort', 'very_long_body', 'Long content', 20, 'long content to work through');
  } else if (bodyLen > 1500) {
    add('effort', 'long_body', 'Substantial content', 10, 'substantial content to read');
  }

  const attachments = item.attachmentCount ?? 0;
  if (attachments >= 3) {
    add('effort', 'many_attachments', 'Several attachments', 18, `${attachments} attachments to review`);
  } else if (attachments >= 1) {
    add(
      'effort',
      'attachments',
      'Has attachments',
      10,
      `${attachments} attachment${attachments === 1 ? '' : 's'} to review`,
    );
  }

  if (item.participants.length >= 5) {
    add(
      'effort',
      'many_participants',
      'Many people involved',
      12,
      `${item.participants.length} people involved`,
    );
  }

  const hasPrep = PREP_RE.test(text);
  if (hasPrep) {
    add('effort', 'prep_work', 'Preparation required', 12, 'requires preparation work');
  }
  if (COORDINATION_RE.test(text)) {
    add('effort', 'coordination', 'Coordination required', 10, 'requires coordination across people');
  }

  const isDocCategory = item.category === 'storage' || item.category === 'upload';
  if (isDocCategory && bodyLen > 1500) {
    add('effort', 'doc_review', 'Document review', 8, 'a document to review');
  }

  const hasAgenda = item.category === 'calendar' && (item.bodyText?.trim() ?? '') !== '';
  if (hasAgenda) {
    add('effort', 'agenda', 'Meeting has an agenda', 6, 'an agenda to review beforehand');
  }

  // ======================= TOTALS =======================
  const importance = clampScore(totals.importance);
  const urgency = clampScore(totals.urgency);
  const effort = clampScore(totals.effort);
  const overall = clampScore(importance * 0.55 + urgency * 0.45);

  // ======================= PLANNING CATEGORY (first match wins) =======================
  const calendarTodayOrTomorrow =
    !Number.isNaN(meetingStartMs) &&
    !Number.isNaN(nowMs) &&
    meetingStartMs >= nowMs &&
    (utcDay(meetingStartMs) === utcDay(nowMs) || utcDay(meetingStartMs) === utcDay(nowMs + DAY_MS));
  const directedAtUser = blocksOthers || directlyAddressed;

  let planningCategory: PlanningCategory;
  if (calendarTodayOrTomorrow && (hasPrep || hasAgenda)) {
    planningCategory = 'prepare_today';
  } else if (urgency >= 65 && importance >= 50) {
    planningCategory = 'do_now';
  } else if (DECISION_RE.test(text) && importance >= 45) {
    planningCategory = 'decide';
  } else if ((staleAwaiting || WAITING_ON_RE.test(text)) && !directedAtUser) {
    planningCategory = 'waiting_on_others';
  } else if (staleAwaiting && directedAtUser) {
    planningCategory = 'follow_up';
  } else if (urgency < 40 && bodyLen > 800 && (isDocCategory || LONG_FORM_RE.test(text))) {
    planningCategory = 'read_when_possible';
  } else if (importance < 35 && urgency < 35) {
    planningCategory = 'low_priority';
  } else {
    planningCategory = 'follow_up';
  }

  // ======================= EXPLANATION =======================
  const positive = [...signals]
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  const phrases: string[] = [];
  for (const s of positive) {
    const phrase = s.detail ?? lowerFirst(s.label);
    if (!phrases.includes(phrase)) phrases.push(phrase);
    if (phrases.length === 3) break;
  }
  const explanation =
    phrases.length === 0
      ? 'No strong signals — looks routine.'
      : `${upperFirst(phrases.join(', '))}.`;

  // ======================= RECOMMENDED ACTION =======================
  const isOverdue = signals.some((s) => s.key === 'urgency.overdue');
  const nudgeName =
    item.sender?.name ?? item.sender?.email ?? item.participants.find((p) => p.name)?.name ?? 'them';
  const waitDays = Math.max(1, staleDays);

  let recommendedAction: string;
  switch (planningCategory) {
    case 'prepare_today': {
      const time =
        item.startsAt !== null &&
        item.startsAt !== undefined &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(item.startsAt)
          ? item.startsAt.slice(11, 16)
          : null;
      recommendedAction =
        time !== null ? `Prepare before the ${time} meeting.` : 'Prepare for the upcoming meeting.';
      break;
    }
    case 'do_now':
      recommendedAction = isOverdue
        ? 'Do this first — it is already overdue.'
        : item.category === 'email' || item.category === 'chat'
          ? 'Reply today.'
          : 'Act on this today.';
      break;
    case 'decide': {
      const weekday = !Number.isNaN(dueMs) ? WEEKDAY_NAMES[new Date(dueMs).getUTCDay()] : undefined;
      recommendedAction =
        weekday !== undefined
          ? `Review and decide by ${weekday}.`
          : 'Review and decide when you have a focused block.';
      break;
    }
    case 'waiting_on_others':
      recommendedAction = `Nudge ${nudgeName} — no reply in ${waitDays} day${waitDays === 1 ? '' : 's'}.`;
      break;
    case 'follow_up':
      recommendedAction = staleAwaiting
        ? `Follow up — this has waited ${waitDays} day${waitDays === 1 ? '' : 's'}.`
        : 'Follow up when you get a chance.';
      break;
    case 'read_when_possible':
      recommendedAction =
        bodyLen > 4000 ? 'Set aside 30 minutes to read this.' : 'Skim when you have 20 minutes.';
      break;
    case 'low_priority':
      recommendedAction = 'Safe to ignore for now.';
      break;
  }

  return {
    importance,
    urgency,
    effort,
    overall,
    priorityLevel: toLevel(overall),
    urgencyLevel: toLevel(urgency),
    effortLevel: toLevel(effort),
    planningCategory,
    signals,
    explanation,
    recommendedAction,
  };
}

/**
 * Merge an optional LLM refinement over a rule-based score.
 * Deltas are clamped to ±15 so the deterministic rules stay in charge;
 * refined explanation/action/category are preferred when provided;
 * extraSignals are appended for transparency.
 */
export function applyRefinement(base: PriorityScore, r: LlmScoreRefinement): PriorityScore {
  const clampDelta = (d: number | undefined): number =>
    d === undefined
      ? 0
      : Math.max(-REFINEMENT_DELTA_LIMIT, Math.min(REFINEMENT_DELTA_LIMIT, d));

  const importance = clampScore(base.importance + clampDelta(r.importanceDelta));
  const urgency = clampScore(base.urgency + clampDelta(r.urgencyDelta));
  const effort = clampScore(base.effort + clampDelta(r.effortDelta));
  const overall = clampScore(importance * 0.55 + urgency * 0.45);

  const explanation =
    r.explanation !== undefined && r.explanation.trim() !== '' ? r.explanation : base.explanation;
  const recommendedAction =
    r.recommendedAction !== undefined && r.recommendedAction.trim() !== ''
      ? r.recommendedAction
      : base.recommendedAction;

  return {
    importance,
    urgency,
    effort,
    overall,
    priorityLevel: toLevel(overall),
    urgencyLevel: toLevel(urgency),
    effortLevel: toLevel(effort),
    planningCategory: r.planningCategory ?? base.planningCategory,
    signals: [...base.signals, ...(r.extraSignals ?? [])],
    explanation,
    recommendedAction,
  };
}
