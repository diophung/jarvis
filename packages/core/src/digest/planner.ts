/**
 * Deterministic digest planner.
 *
 * Selects and groups scored candidates into debrief sections. Each candidate
 * lands in EXACTLY ONE best section (priority order below). The fallback
 * markdown is what the user sees when no LLM is configured, so it must read
 * like a calm chief of staff, not a notification dump.
 *
 * Pure: all time math is relative to `opts.now`.
 */
import { DIGEST_SECTIONS } from '../enums.js';
import type { DigestSection, PlanningCategory } from '../enums.js';
import type {
  DigestCandidate,
  DigestPlan,
  DigestPlannerOptions,
  PlannedDigestItem,
} from './types.js';

const HOUR_MS = 3_600_000;
const MEETING_HORIZON_MS = 36 * HOUR_MS;
const MISSED_AGE_MS = 48 * HOUR_MS;
const DEFAULT_MAX_PER_SECTION = 5;
const SUMMARY_HIGHLIGHT_COUNT = 4;
const PLAN_MAX_PER_BUCKET = 5;

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function hasSignal(candidate: DigestCandidate, fragment: string): boolean {
  return candidate.score.signals.some((s) => s.key.includes(fragment));
}

/** Pick the single best section for a candidate, or null when it qualifies nowhere. */
function pickSection(candidate: DigestCandidate, nowMs: number): DigestSection | null {
  const score = candidate.score;
  const tsMs =
    candidate.itemTimestamp !== null ? Date.parse(candidate.itemTimestamp) : Number.NaN;

  // 1. Meetings needing prep: calendar items within the next 36h with prep/effort signals.
  if (
    candidate.sourceCategory === 'calendar' &&
    !Number.isNaN(tsMs) &&
    tsMs - nowMs >= 0 &&
    tsMs - nowMs <= MEETING_HORIZON_MS &&
    (hasSignal(candidate, 'effort.prep') ||
      hasSignal(candidate, 'effort.agenda') ||
      score.planningCategory === 'prepare_today')
  ) {
    return 'meetings_prep';
  }
  // 2. Risks & blockers: escalation / blocking signals.
  if (hasSignal(candidate, 'escalation') || hasSignal(candidate, 'blocking')) {
    return 'risks';
  }
  // 3. Most urgent.
  if (score.urgency >= 55) return 'most_urgent';
  // 4. Most important.
  if (score.importance >= 55) return 'most_important';
  // 5. Missed: still important, sat unread/awaiting for over 48h.
  if (
    score.importance >= 50 &&
    !Number.isNaN(tsMs) &&
    nowMs - tsMs > MISSED_AGE_MS &&
    (hasSignal(candidate, 'unread') || hasSignal(candidate, 'stale'))
  ) {
    return 'missed';
  }
  // 6. Follow-ups.
  if (score.planningCategory === 'follow_up' || score.planningCategory === 'waiting_on_others') {
    return 'follow_ups';
  }
  // 7. High-effort work.
  if (score.effort >= 60) return 'high_effort';
  // 8. Worth reading.
  if (score.planningCategory === 'read_when_possible') return 'reading';
  return null;
}

function compareCandidates(a: DigestCandidate, b: DigestCandidate): number {
  return (
    b.score.overall - a.score.overall ||
    a.title.localeCompare(b.title) ||
    (a.sourceItemId ?? '').localeCompare(b.sourceItemId ?? '')
  );
}

function toPlannedItem(
  candidate: DigestCandidate,
  section: DigestSection,
  rank: number,
): PlannedDigestItem {
  const score = candidate.score;
  return {
    sourceItemId: candidate.sourceItemId,
    taskCandidateId: candidate.taskCandidateId,
    title: candidate.title,
    sourceLabel: candidate.sourceLabel,
    sourceCategory: candidate.sourceCategory,
    itemTimestamp: candidate.itemTimestamp,
    section,
    planningCategory: score.planningCategory,
    priorityLevel: score.priorityLevel,
    urgencyLevel: score.urgencyLevel,
    effortLevel: score.effortLevel,
    recommendedAction: score.recommendedAction,
    explanation: score.explanation,
    signals: score.signals,
    rank,
  };
}

function formatLongDate(nowIso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(nowIso);
  if (!match) return nowIso;
  const year = Number(match[1] ?? '0');
  const month = Number(match[2] ?? '1');
  const day = Number(match[3] ?? '1');
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '';
  const monthName = MONTH_NAMES[month - 1] ?? '';
  return `${weekday}, ${monthName} ${day}, ${year}`;
}

function greetingFor(nowIso: string): string {
  const match = /T(\d{2})/.exec(nowIso);
  const hour = match ? Number(match[1] ?? '9') : 9;
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function buildSummary(
  kept: DigestCandidate[],
  stats: Record<string, number>,
  nowIso: string,
): string {
  const lines: string[] = [];
  lines.push(`${greetingFor(nowIso)} — here's your debrief for ${formatLongDate(nowIso)}.`);
  lines.push('');
  if (kept.length === 0) {
    lines.push('All clear — nothing needs your attention right now. Enjoy the breathing room.');
    return lines.join('\n');
  }
  const sectionsUsed = DIGEST_SECTIONS.filter((s) => (stats[s] ?? 0) > 0).length;
  const itemWord = kept.length === 1 ? 'item needs' : 'items need';
  const sectionWord = sectionsUsed === 1 ? 'section' : 'sections';
  lines.push(`**${kept.length} ${itemWord} your attention** across ${sectionsUsed} ${sectionWord}.`);
  lines.push('');
  const highlights = [...kept].sort(compareCandidates).slice(0, SUMMARY_HIGHLIGHT_COUNT);
  for (const candidate of highlights) {
    lines.push(`- **${candidate.title}** — ${candidate.score.explanation}`);
  }
  return lines.join('\n');
}

const PLAN_BUCKETS: ReadonlyArray<{ label: string; category: PlanningCategory }> = [
  { label: 'Morning', category: 'do_now' },
  { label: 'Midday', category: 'prepare_today' },
  { label: 'Afternoon', category: 'follow_up' },
];

function buildPlan(kept: DigestCandidate[]): string {
  const lines: string[] = ['## Suggested plan', ''];
  let anyBucket = false;
  for (const bucket of PLAN_BUCKETS) {
    const group = kept
      .filter((c) => c.score.planningCategory === bucket.category)
      .sort(compareCandidates)
      .slice(0, PLAN_MAX_PER_BUCKET);
    if (group.length === 0) continue;
    anyBucket = true;
    lines.push(`**${bucket.label}**`);
    for (const candidate of group) {
      const action = candidate.score.recommendedAction;
      lines.push(action !== '' ? `- ${candidate.title} — ${action}` : `- ${candidate.title}`);
    }
    lines.push('');
  }
  if (!anyBucket) {
    lines.push('Nothing is time-boxed today — a good day to protect time for deep work.');
  }
  return lines.join('\n').trimEnd();
}

/** Plan a digest from scored candidates. Deterministic for a fixed (candidates, opts). */
export function planDigest(candidates: DigestCandidate[], opts: DigestPlannerOptions): DigestPlan {
  const maxPerSection = Math.max(1, opts.maxPerSection ?? DEFAULT_MAX_PER_SECTION);
  const nowMs = Date.parse(opts.now);

  const bySection = new Map<DigestSection, DigestCandidate[]>();
  let ignored = 0;
  let unplaced = 0;
  for (const candidate of candidates) {
    const section = pickSection(candidate, nowMs);
    if (section !== null) {
      const list = bySection.get(section);
      if (list) list.push(candidate);
      else bySection.set(section, [candidate]);
    } else if (candidate.score.importance < 35 && candidate.score.urgency < 35) {
      ignored += 1;
    } else {
      unplaced += 1;
    }
  }

  const items: PlannedDigestItem[] = [];
  const kept: DigestCandidate[] = [];
  const stats: Record<string, number> = {};
  let overflow = 0;
  for (const section of DIGEST_SECTIONS) {
    const list = [...(bySection.get(section) ?? [])].sort(compareCandidates);
    const selected = list.slice(0, maxPerSection);
    overflow += list.length - selected.length;
    stats[section] = selected.length;
    selected.forEach((candidate, rank) => {
      items.push(toPlannedItem(candidate, section, rank));
      kept.push(candidate);
    });
  }

  stats['totalConsidered'] = candidates.length;
  stats['ignored'] = ignored;
  stats['overflow'] = overflow;
  stats['unplaced'] = unplaced;

  return {
    items,
    stats,
    fallbackSummaryMarkdown: buildSummary(kept, stats, opts.now),
    fallbackPlanMarkdown: buildPlan(kept),
  };
}
