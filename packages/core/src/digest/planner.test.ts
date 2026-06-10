import { describe, expect, it } from 'vitest';
import type { ScoreSignal } from '../entities.js';
import type { PriorityScore } from '../scoring/types.js';
import type { DigestCandidate } from './types.js';
import { planDigest } from './planner.js';

const NOW = '2026-06-09T08:00:00Z';

function mkScore(overrides: Partial<PriorityScore> = {}): PriorityScore {
  return {
    importance: 40,
    urgency: 40,
    effort: 30,
    overall: 40,
    priorityLevel: 'medium',
    urgencyLevel: 'medium',
    effortLevel: 'low',
    planningCategory: 'follow_up',
    signals: [],
    explanation: 'A routine item.',
    recommendedAction: 'Follow up when you get a chance.',
    ...overrides,
  };
}

let nextId = 0;
function mkCand(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  nextId += 1;
  return {
    sourceItemId: `itm_${nextId}`,
    taskCandidateId: null,
    title: `Item ${nextId}`,
    sourceLabel: 'Gmail',
    sourceCategory: 'email',
    itemTimestamp: '2026-06-09T06:00:00Z',
    score: mkScore(),
    ...overrides,
  };
}

function sig(key: string, weight = 10): ScoreSignal {
  return { key, label: key, weight };
}

// --- demo-beat archetypes ---
const archetypes = {
  meeting: () =>
    mkCand({
      title: 'Board meeting prep',
      sourceCategory: 'calendar',
      sourceLabel: 'Calendar',
      itemTimestamp: '2026-06-09T14:00:00Z', // 6h away
      score: mkScore({
        importance: 60,
        urgency: 60,
        overall: 60,
        planningCategory: 'prepare_today',
        signals: [sig('effort.prep_work', 12), sig('effort.agenda', 6)],
        recommendedAction: 'Prepare before the 14:00 meeting.',
        explanation: 'Meeting today, requires preparation.',
      }),
    }),
  risk: () =>
    mkCand({
      title: 'Production escalation',
      score: mkScore({
        importance: 70,
        urgency: 80,
        overall: 75,
        planningCategory: 'do_now',
        signals: [sig('urgency.escalation', 10), sig('importance.blocking_others', 12)],
        explanation: 'Escalation language, someone is blocked on you.',
        recommendedAction: 'Reply today.',
      }),
    }),
  urgent: () =>
    mkCand({
      title: 'Visa application deadline',
      score: mkScore({
        importance: 45,
        urgency: 70,
        overall: 56,
        planningCategory: 'do_now',
        signals: [sig('urgency.due_within_24h', 32)],
        explanation: 'Due tomorrow.',
        recommendedAction: 'Act on this today.',
      }),
    }),
  important: () =>
    mkCand({
      title: 'CEO strategy memo',
      score: mkScore({
        importance: 75,
        urgency: 40,
        overall: 59,
        signals: [sig('importance.sender_vip', 30)],
        explanation: 'From the CEO (key stakeholder).',
      }),
    }),
  missed: () =>
    mkCand({
      title: 'Unanswered partner question',
      itemTimestamp: '2026-06-05T08:00:00Z', // 4 days old
      score: mkScore({
        importance: 52,
        urgency: 42,
        overall: 48,
        signals: [sig('urgency.stale_awaiting_reply', 12)],
        explanation: 'Awaiting a reply for 4 days.',
      }),
    }),
  followUp: () =>
    mkCand({
      title: 'Design assets thread',
      score: mkScore({
        importance: 40,
        urgency: 42,
        overall: 41,
        planningCategory: 'waiting_on_others',
        recommendedAction: 'Nudge Priya — no reply in 5 days.',
        explanation: 'Waiting on someone else.',
      }),
    }),
  highEffort: () =>
    mkCand({
      title: 'Quarterly analysis doc',
      score: mkScore({
        importance: 45,
        urgency: 30,
        overall: 38,
        effort: 70,
        effortLevel: 'high',
        planningCategory: 'do_now',
        signals: [sig('effort.very_long_body', 20)],
        explanation: 'Long content to work through.',
        recommendedAction: 'Act on this today.',
      }),
    }),
  reading: () =>
    mkCand({
      title: 'Market research report',
      score: mkScore({
        importance: 38,
        urgency: 20,
        overall: 30,
        effort: 30,
        planningCategory: 'read_when_possible',
        recommendedAction: 'Skim when you have 20 minutes.',
        explanation: 'Long-form reading, no urgency.',
      }),
    }),
  noise: () =>
    mkCand({
      title: 'Vendor newsletter',
      score: mkScore({
        importance: 20,
        urgency: 20,
        overall: 20,
        planningCategory: 'low_priority',
        recommendedAction: 'Safe to ignore for now.',
        explanation: 'No strong signals.',
      }),
    }),
};

describe('planDigest — section assignment', () => {
  it('routes each demo-beat archetype to its expected section', () => {
    const plan = planDigest(
      [
        archetypes.meeting(),
        archetypes.risk(),
        archetypes.urgent(),
        archetypes.important(),
        archetypes.missed(),
        archetypes.followUp(),
        archetypes.highEffort(),
        archetypes.reading(),
      ],
      { now: NOW },
    );
    const sectionOf = (title: string) => plan.items.find((i) => i.title === title)?.section;
    expect(sectionOf('Board meeting prep')).toBe('meetings_prep');
    expect(sectionOf('Production escalation')).toBe('risks');
    expect(sectionOf('Visa application deadline')).toBe('most_urgent');
    expect(sectionOf('CEO strategy memo')).toBe('most_important');
    expect(sectionOf('Unanswered partner question')).toBe('missed');
    expect(sectionOf('Design assets thread')).toBe('follow_ups');
    expect(sectionOf('Quarterly analysis doc')).toBe('high_effort');
    expect(sectionOf('Market research report')).toBe('reading');
  });

  it('places each candidate in exactly one section', () => {
    const candidates = [
      archetypes.meeting(),
      archetypes.risk(),
      archetypes.urgent(),
      archetypes.important(),
      archetypes.missed(),
      archetypes.followUp(),
      archetypes.highEffort(),
      archetypes.reading(),
    ];
    const plan = planDigest(candidates, { now: NOW });
    expect(plan.items.length).toBe(candidates.length);
    const ids = plan.items.map((i) => i.sourceItemId);
    expect(new Set(ids).size).toBe(candidates.length);
  });

  it('does not put future meetings beyond 36h into meetings_prep', () => {
    const farMeeting = mkCand({
      title: 'Next-week planning meeting',
      sourceCategory: 'calendar',
      itemTimestamp: '2026-06-16T09:00:00Z',
      score: mkScore({
        importance: 40,
        urgency: 20,
        overall: 31,
        planningCategory: 'prepare_today',
        signals: [sig('effort.prep_work', 12)],
      }),
    });
    const plan = planDigest([farMeeting], { now: NOW });
    expect(plan.items.find((i) => i.title === 'Next-week planning meeting')?.section).not.toBe(
      'meetings_prep',
    );
  });

  it('drops low-importance, low-urgency noise and counts it as ignored', () => {
    const plan = planDigest([archetypes.noise(), archetypes.important()], { now: NOW });
    expect(plan.items.some((i) => i.title === 'Vendor newsletter')).toBe(false);
    expect(plan.stats['ignored']).toBe(1);
    expect(plan.stats['totalConsidered']).toBe(2);
  });
});

describe('planDigest — ranking, caps, stats', () => {
  it('ranks items by overall desc within a section with sequential ranks', () => {
    const low = mkCand({
      title: 'Mild deadline',
      score: mkScore({ urgency: 58, importance: 40, overall: 48 }),
    });
    const high = mkCand({
      title: 'Hard deadline',
      score: mkScore({ urgency: 90, importance: 50, overall: 68 }),
    });
    const plan = planDigest([low, high], { now: NOW });
    const urgentItems = plan.items.filter((i) => i.section === 'most_urgent');
    expect(urgentItems.map((i) => i.title)).toEqual(['Hard deadline', 'Mild deadline']);
    expect(urgentItems.map((i) => i.rank)).toEqual([0, 1]);
  });

  it('caps sections at maxPerSection and counts overflow in stats', () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      mkCand({
        title: `Urgent thing ${i}`,
        score: mkScore({ urgency: 60 + i, importance: 45, overall: 52 + i }),
      }),
    );
    const plan = planDigest(candidates, { now: NOW });
    expect(plan.stats['most_urgent']).toBe(5); // default cap
    expect(plan.stats['overflow']).toBe(3);
    expect(plan.items.filter((i) => i.section === 'most_urgent').length).toBe(5);

    const tight = planDigest(candidates, { now: NOW, maxPerSection: 2 });
    expect(tight.stats['most_urgent']).toBe(2);
    expect(tight.stats['overflow']).toBe(6);
  });

  it('reports per-section counts plus totals', () => {
    const plan = planDigest([archetypes.risk(), archetypes.reading(), archetypes.noise()], {
      now: NOW,
    });
    expect(plan.stats['risks']).toBe(1);
    expect(plan.stats['reading']).toBe(1);
    expect(plan.stats['most_urgent']).toBe(0);
    expect(plan.stats['totalConsidered']).toBe(3);
    expect(plan.stats['ignored']).toBe(1);
  });
});

describe('planDigest — fallback markdown', () => {
  it('summarizes top items by title with their explanations', () => {
    const plan = planDigest([archetypes.risk(), archetypes.important(), archetypes.meeting()], {
      now: NOW,
    });
    expect(plan.fallbackSummaryMarkdown).toContain('items need your attention');
    expect(plan.fallbackSummaryMarkdown).toContain('Production escalation');
    expect(plan.fallbackSummaryMarkdown).toContain('CEO strategy memo');
    expect(plan.fallbackSummaryMarkdown).toContain('Board meeting prep');
    expect(plan.fallbackSummaryMarkdown).toContain('Tuesday, June 9, 2026');
    expect(plan.fallbackSummaryMarkdown).toContain('Good morning');
  });

  it('builds a suggested plan with Morning/Midday/Afternoon groupings', () => {
    const plan = planDigest(
      [archetypes.risk(), archetypes.meeting(), archetypes.followUp(), archetypes.missed()],
      { now: NOW },
    );
    expect(plan.fallbackPlanMarkdown).toContain('## Suggested plan');
    expect(plan.fallbackPlanMarkdown).toContain('**Morning**'); // do_now -> risk archetype
    expect(plan.fallbackPlanMarkdown).toContain('Production escalation');
    expect(plan.fallbackPlanMarkdown).toContain('**Midday**'); // prepare_today -> meeting
    expect(plan.fallbackPlanMarkdown).toContain('Board meeting prep');
    expect(plan.fallbackPlanMarkdown).toContain('**Afternoon**'); // follow_up category -> missed item
    expect(plan.fallbackPlanMarkdown).toContain('Unanswered partner question');
  });

  it('handles empty candidates with a calm all-clear summary', () => {
    const plan = planDigest([], { now: NOW });
    expect(plan.items).toEqual([]);
    expect(plan.stats['totalConsidered']).toBe(0);
    expect(plan.stats['ignored']).toBe(0);
    expect(plan.fallbackSummaryMarkdown).toContain('All clear');
    expect(plan.fallbackPlanMarkdown).toContain('## Suggested plan');
  });

  it('greets by time of day from opts.now', () => {
    const morning = planDigest([], { now: '2026-06-09T08:00:00Z' });
    const afternoon = planDigest([], { now: '2026-06-09T14:00:00Z' });
    const evening = planDigest([], { now: '2026-06-09T19:30:00Z' });
    expect(morning.fallbackSummaryMarkdown).toContain('Good morning');
    expect(afternoon.fallbackSummaryMarkdown).toContain('Good afternoon');
    expect(evening.fallbackSummaryMarkdown).toContain('Good evening');
  });

  it('is deterministic for the same inputs', () => {
    const candidates = [archetypes.risk(), archetypes.meeting(), archetypes.reading()];
    const a = planDigest(candidates, { now: NOW });
    const b = planDigest(candidates, { now: NOW });
    expect(a).toEqual(b);
  });
});
