import { describe, expect, it } from 'vitest';
import type {
  LlmScoreRefinement,
  PersonSignal,
  ProjectSignal,
  ScorableItem,
  ScoringContext,
} from './types.js';
import { applyRefinement, scoreItem, toLevel } from './engine.js';

const NOW = '2026-06-09T08:00:00Z'; // a Tuesday

function makeItem(overrides: Partial<ScorableItem> = {}): ScorableItem {
  return {
    id: 'itm_1',
    category: 'email',
    provider: 'gmail',
    title: 'Project status',
    bodyText: 'Here is the latest status.',
    snippet: null,
    sender: { name: 'Alex Kim', email: 'alex@acme.com' },
    participants: [],
    itemTimestamp: '2026-06-09T06:00:00Z',
    dueAt: null,
    startsAt: null,
    endsAt: null,
    threadExternalId: null,
    labels: [],
    isRead: 1,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    now: NOW,
    people: [],
    projects: [],
    preferences: {
      topicsPrioritize: [],
      topicsIgnore: [],
      sourcesPrioritize: [],
      sourcesIgnore: [],
    },
    feedback: [],
    selfEmails: [],
    ...overrides,
  };
}

function person(overrides: Partial<PersonSignal> = {}): PersonSignal {
  return {
    personId: 'per_1',
    displayName: 'Sarah Okafor',
    emails: ['sarah@acme.com'],
    handles: [],
    importance: 'vip',
    interactionCount: 5,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSignal> = {}): ProjectSignal {
  return {
    projectId: 'prj_1',
    name: 'Atlas Launch',
    keywords: ['atlas'],
    priority: 'high',
    status: 'active',
    dueAt: null,
    ...overrides,
  };
}

describe('toLevel', () => {
  it('maps thresholds: >=75 critical, >=55 high, >=35 medium, else low', () => {
    expect(toLevel(100)).toBe('critical');
    expect(toLevel(75)).toBe('critical');
    expect(toLevel(74)).toBe('high');
    expect(toLevel(55)).toBe('high');
    expect(toLevel(54)).toBe('medium');
    expect(toLevel(35)).toBe('medium');
    expect(toLevel(34)).toBe('low');
    expect(toLevel(0)).toBe('low');
  });
});

describe('scoreItem — importance', () => {
  it('raises importance by 30 for a VIP sender and records the signal', () => {
    const item = makeItem({ sender: { name: 'Sarah Okafor', email: 'sarah@acme.com' } });
    const baseline = scoreItem(item, makeCtx());
    const scored = scoreItem(item, makeCtx({ people: [person({ importance: 'vip' })] }));
    expect(scored.importance).toBe(baseline.importance + 30);
    const signal = scored.signals.find((s) => s.key === 'importance.sender_vip');
    expect(signal).toBeDefined();
    expect(signal!.weight).toBe(30);
    expect(signal!.detail).toContain('Sarah Okafor');
  });

  it('floors importance at 0 for an ignored sender', () => {
    const item = makeItem({
      title: 'FYI notes',
      bodyText: 'Meeting minutes attached for reference.',
      sender: { email: 'sarah@acme.com' },
    });
    const scored = scoreItem(item, makeCtx({ people: [person({ importance: 'ignore' })] }));
    expect(scored.importance).toBe(0);
    expect(scored.signals.some((s) => s.key === 'importance.sender_ignore' && s.weight === -40)).toBe(
      true,
    );
  });

  it('adds frequent-contact weight when interactionCount >= 20', () => {
    const item = makeItem({ sender: { email: 'sarah@acme.com' } });
    const infrequent = scoreItem(item, makeCtx({ people: [person({ interactionCount: 19 })] }));
    const frequent = scoreItem(item, makeCtx({ people: [person({ interactionCount: 20 })] }));
    expect(frequent.importance).toBe(infrequent.importance + 6);
    expect(frequent.signals.some((s) => s.key === 'importance.frequent_contact')).toBe(true);
  });

  it('detects direct addressing via selfEmails in participants', () => {
    const item = makeItem({ participants: [{ email: 'me@acme.com' }] });
    const scored = scoreItem(item, makeCtx({ selfEmails: ['ME@acme.com'] }));
    expect(scored.signals.some((s) => s.key === 'importance.directly_addressed')).toBe(true);
  });

  it('adds project match (+15) plus high-priority project bonus (+8)', () => {
    const item = makeItem({ title: 'Atlas launch checklist' });
    const normalPrj = scoreItem(item, makeCtx({ projects: [project({ priority: 'normal' })] }));
    const highPrj = scoreItem(item, makeCtx({ projects: [project({ priority: 'high' })] }));
    const none = scoreItem(item, makeCtx());
    expect(normalPrj.importance).toBe(none.importance + 15);
    expect(highPrj.importance).toBe(none.importance + 23);
    expect(highPrj.signals.some((s) => s.key === 'importance.project_match')).toBe(true);
    expect(highPrj.signals.some((s) => s.key === 'importance.project_priority_high')).toBe(true);
  });

  it('applies topic prioritize (+15) and ignore (-25) preferences', () => {
    const item = makeItem({ title: 'Security audit results' });
    const prioritized = scoreItem(
      item,
      makeCtx({
        preferences: {
          topicsPrioritize: ['security'],
          topicsIgnore: [],
          sourcesPrioritize: [],
          sourcesIgnore: [],
        },
      }),
    );
    const ignoredTopic = scoreItem(
      item,
      makeCtx({
        preferences: {
          topicsPrioritize: [],
          topicsIgnore: ['security'],
          sourcesPrioritize: [],
          sourcesIgnore: [],
        },
      }),
    );
    const none = scoreItem(item, makeCtx());
    expect(prioritized.importance).toBe(none.importance + 15);
    expect(ignoredTopic.importance).toBe(none.importance - 25);
  });

  it('applies source prioritize (+10) and ignore (-20) by provider', () => {
    const item = makeItem({ provider: 'rss' });
    const none = scoreItem(item, makeCtx());
    const prioritized = scoreItem(
      item,
      makeCtx({
        preferences: {
          topicsPrioritize: [],
          topicsIgnore: [],
          sourcesPrioritize: ['RSS'],
          sourcesIgnore: [],
        },
      }),
    );
    const ignoredSrc = scoreItem(
      item,
      makeCtx({
        preferences: {
          topicsPrioritize: [],
          topicsIgnore: [],
          sourcesPrioritize: [],
          sourcesIgnore: ['rss'],
        },
      }),
    );
    expect(prioritized.importance).toBe(none.importance + 10);
    expect(ignoredSrc.importance).toBe(none.importance - 20);
  });

  it('detects escalation, deadline, and blocking language', () => {
    const scored = scoreItem(
      makeItem({
        bodyText: 'This is a blocker — the team is blocked on you and the deadline is close.',
      }),
      makeCtx(),
    );
    expect(scored.signals.some((s) => s.key === 'importance.escalation')).toBe(true);
    expect(scored.signals.some((s) => s.key === 'importance.deadline_language')).toBe(true);
    expect(scored.signals.some((s) => s.key === 'importance.blocking_others')).toBe(true);
    expect(scored.signals.some((s) => s.key === 'urgency.escalation')).toBe(true);
  });
});

describe('scoreItem — urgency', () => {
  it('orders urgency: overdue > due tomorrow > due in 3 days', () => {
    const base = { title: 'Submit report', bodyText: 'See attachment.', isRead: 1 as const };
    const overdue = scoreItem(
      makeItem({ ...base, dueAt: '2026-06-09T06:00:00Z' }), // 2h ago
      makeCtx(),
    );
    const tomorrow = scoreItem(
      makeItem({ ...base, dueAt: '2026-06-10T04:00:00Z' }), // 20h away
      makeCtx(),
    );
    const threeDays = scoreItem(
      makeItem({ ...base, dueAt: '2026-06-12T06:00:00Z' }), // 70h away
      makeCtx(),
    );
    expect(overdue.urgency).toBeGreaterThan(tomorrow.urgency);
    expect(tomorrow.urgency).toBeGreaterThan(threeDays.urgency);
    expect(overdue.signals.some((s) => s.key === 'urgency.overdue' && s.weight === 45)).toBe(true);
    expect(tomorrow.signals.some((s) => s.key === 'urgency.due_within_24h' && s.weight === 32)).toBe(
      true,
    );
    expect(
      threeDays.signals.some((s) => s.key === 'urgency.due_within_72h' && s.weight === 18),
    ).toBe(true);
  });

  it('boosts due within 4 hours above due within 24 hours', () => {
    const soon = scoreItem(makeItem({ dueAt: '2026-06-09T10:00:00Z' }), makeCtx());
    const today = scoreItem(makeItem({ dueAt: '2026-06-09T20:00:00Z' }), makeCtx());
    expect(soon.urgency).toBeGreaterThan(today.urgency);
    expect(soon.signals.some((s) => s.key === 'urgency.due_within_4h' && s.weight === 40)).toBe(true);
  });

  it('boosts calendar events starting within 4h, today, and tomorrow', () => {
    const mk = (startsAt: string) =>
      scoreItem(makeItem({ category: 'calendar', startsAt, bodyText: null }), makeCtx());
    const within4h = mk('2026-06-09T10:00:00Z');
    const today = mk('2026-06-09T18:00:00Z');
    const tomorrow = mk('2026-06-10T09:00:00Z');
    const nextWeek = mk('2026-06-16T09:00:00Z');
    expect(within4h.signals.some((s) => s.key === 'urgency.meeting_within_4h')).toBe(true);
    expect(today.signals.some((s) => s.key === 'urgency.meeting_today')).toBe(true);
    expect(tomorrow.signals.some((s) => s.key === 'urgency.meeting_tomorrow')).toBe(true);
    expect(within4h.urgency).toBeGreaterThan(today.urgency);
    expect(today.urgency).toBeGreaterThan(tomorrow.urgency);
    expect(tomorrow.urgency).toBeGreaterThan(nextWeek.urgency);
  });

  it('detects time-sensitive wording', () => {
    const scored = scoreItem(makeItem({ bodyText: 'Please send this by EOD.' }), makeCtx());
    expect(scored.signals.some((s) => s.key === 'urgency.time_sensitive' && s.weight === 15)).toBe(
      true,
    );
  });

  it('adds unread+recent boost only when unread and under 24h old', () => {
    const recentUnread = scoreItem(
      makeItem({ isRead: 0, itemTimestamp: '2026-06-09T01:00:00Z' }),
      makeCtx(),
    );
    const recentRead = scoreItem(
      makeItem({ isRead: 1, itemTimestamp: '2026-06-09T01:00:00Z' }),
      makeCtx(),
    );
    const oldUnread = scoreItem(
      makeItem({ isRead: 0, itemTimestamp: '2026-06-06T01:00:00Z' }),
      makeCtx(),
    );
    expect(recentUnread.signals.some((s) => s.key === 'urgency.unread_recent')).toBe(true);
    expect(recentRead.signals.some((s) => s.key === 'urgency.unread_recent')).toBe(false);
    expect(oldUnread.signals.some((s) => s.key === 'urgency.unread_recent')).toBe(false);
  });

  it('flags stale threads awaiting a reply (>3 days with a question)', () => {
    const stale = scoreItem(
      makeItem({
        itemTimestamp: '2026-06-04T08:00:00Z', // 5 days old
        bodyText: 'Did you get a chance to look at this?',
      }),
      makeCtx(),
    );
    const fresh = scoreItem(
      makeItem({
        itemTimestamp: '2026-06-08T08:00:00Z',
        bodyText: 'Did you get a chance to look at this?',
      }),
      makeCtx(),
    );
    expect(stale.signals.some((s) => s.key === 'urgency.stale_awaiting_reply' && s.weight === 12)).toBe(
      true,
    );
    expect(fresh.signals.some((s) => s.key === 'urgency.stale_awaiting_reply')).toBe(false);
  });
});

describe('scoreItem — feedback adjustments', () => {
  it('applies important / not_important feedback by sender', () => {
    const item = makeItem({ sender: { email: 'bob@x.com' } });
    const none = scoreItem(item, makeCtx());
    const liked = scoreItem(
      item,
      makeCtx({ feedback: [{ kind: 'important', senderEmail: 'bob@x.com' }] }),
    );
    const disliked = scoreItem(
      item,
      makeCtx({ feedback: [{ kind: 'not_important', senderEmail: 'bob@x.com' }] }),
    );
    expect(liked.importance).toBe(none.importance + 10);
    expect(disliked.importance).toBe(none.importance - 15);
  });

  it('applies more_like_this feedback by keyword', () => {
    const item = makeItem({ title: 'Atlas weekly sync notes' });
    const none = scoreItem(item, makeCtx());
    const boosted = scoreItem(
      item,
      makeCtx({ feedback: [{ kind: 'more_like_this', keywords: ['atlas'] }] }),
    );
    expect(boosted.importance).toBe(none.importance + 10);
  });

  it('applies urgent / not_urgent feedback', () => {
    const item = makeItem({ sender: { email: 'bob@x.com' } });
    const none = scoreItem(item, makeCtx());
    const urgent = scoreItem(
      item,
      makeCtx({ feedback: [{ kind: 'urgent', senderEmail: 'bob@x.com' }] }),
    );
    const notUrgent = scoreItem(
      item,
      makeCtx({ feedback: [{ kind: 'not_urgent', senderEmail: 'bob@x.com' }] }),
    );
    expect(urgent.urgency).toBe(none.urgency + 12);
    expect(notUrgent.urgency).toBe(none.urgency - 15);
  });

  it('does not apply feedback that matches neither sender nor keywords', () => {
    const item = makeItem({ sender: { email: 'bob@x.com' } });
    const none = scoreItem(item, makeCtx());
    const unrelated = scoreItem(
      item,
      makeCtx({ feedback: [{ kind: 'important', senderEmail: 'carol@x.com', keywords: ['zzz'] }] }),
    );
    expect(unrelated.importance).toBe(none.importance);
  });
});

describe('scoreItem — effort', () => {
  it('weights long bodies, attachments, and many participants', () => {
    const big = scoreItem(
      makeItem({
        bodyText: 'x'.repeat(4500),
        attachmentCount: 3,
        participants: [
          { email: 'a@x.com' },
          { email: 'b@x.com' },
          { email: 'c@x.com' },
          { email: 'd@x.com' },
          { email: 'e@x.com' },
        ],
      }),
      makeCtx(),
    );
    expect(big.signals.some((s) => s.key === 'effort.very_long_body' && s.weight === 20)).toBe(true);
    expect(big.signals.some((s) => s.key === 'effort.many_attachments' && s.weight === 18)).toBe(true);
    expect(big.signals.some((s) => s.key === 'effort.many_participants' && s.weight === 12)).toBe(
      true,
    );
    expect(big.effort).toBe(20 + 20 + 18 + 12);
  });

  it('uses medium body and single-attachment tiers', () => {
    const scored = scoreItem(
      makeItem({ bodyText: 'y'.repeat(2000), attachmentCount: 1 }),
      makeCtx(),
    );
    expect(scored.signals.some((s) => s.key === 'effort.long_body' && s.weight === 10)).toBe(true);
    expect(scored.signals.some((s) => s.key === 'effort.attachments' && s.weight === 10)).toBe(true);
  });

  it('detects prep and coordination wording', () => {
    const scored = scoreItem(
      makeItem({ bodyText: 'Please prepare the deck and coordinate with the external team.' }),
      makeCtx(),
    );
    expect(scored.signals.some((s) => s.key === 'effort.prep_work' && s.weight === 12)).toBe(true);
    expect(scored.signals.some((s) => s.key === 'effort.coordination' && s.weight === 10)).toBe(true);
  });

  it('adds doc-review weight for long storage/upload docs and agenda weight for calendar bodies', () => {
    const doc = scoreItem(
      makeItem({ category: 'storage', bodyText: 'z'.repeat(2000) }),
      makeCtx(),
    );
    const meeting = scoreItem(
      makeItem({ category: 'calendar', bodyText: 'Agenda: quarterly numbers.' }),
      makeCtx(),
    );
    expect(doc.signals.some((s) => s.key === 'effort.doc_review' && s.weight === 8)).toBe(true);
    expect(meeting.signals.some((s) => s.key === 'effort.agenda' && s.weight === 6)).toBe(true);
  });
});

describe('scoreItem — planning categories and actions', () => {
  it('maps a calendar item today with prep signals to prepare_today', () => {
    const scored = scoreItem(
      makeItem({
        category: 'calendar',
        title: 'Board meeting',
        bodyText: 'Agenda: prepare the launch review deck.',
        startsAt: '2026-06-09T14:00:00Z',
        itemTimestamp: '2026-06-09T14:00:00Z',
      }),
      makeCtx(),
    );
    expect(scored.planningCategory).toBe('prepare_today');
    expect(scored.recommendedAction).toBe('Prepare before the 14:00 meeting.');
  });

  it('maps high urgency + importance to do_now', () => {
    const scored = scoreItem(
      makeItem({
        title: 'Production incident',
        bodyText: 'Critical escalation — customers are blocked. Need your reply ASAP.',
        dueAt: '2026-06-09T10:00:00Z',
        sender: { email: 'sarah@acme.com' },
      }),
      makeCtx({ people: [person({ importance: 'vip' })] }),
    );
    expect(scored.urgency).toBeGreaterThanOrEqual(65);
    expect(scored.importance).toBeGreaterThanOrEqual(50);
    expect(scored.planningCategory).toBe('do_now');
    expect(scored.recommendedAction).toBe('Reply today.');
  });

  it('maps decision language with sufficient importance to decide', () => {
    const scored = scoreItem(
      makeItem({
        title: 'Please approve the Q3 budget',
        bodyText: 'We need your sign-off on the final numbers.',
        dueAt: '2026-06-12T17:00:00Z', // Friday, >72h away
        sender: { email: 'sarah@acme.com' },
      }),
      makeCtx({ people: [person({ importance: 'vip' })] }),
    );
    expect(scored.planningCategory).toBe('decide');
    expect(scored.recommendedAction).toBe('Review and decide by Friday.');
  });

  it('maps stale waiting-on-someone-else threads to waiting_on_others with a nudge', () => {
    const scored = scoreItem(
      makeItem({
        title: 'Design review',
        bodyText: 'Any update on the mockups? Still waiting on the final assets.',
        itemTimestamp: '2026-06-04T08:00:00Z', // 5 days
        sender: { name: 'Priya', email: 'priya@acme.com' },
      }),
      makeCtx(),
    );
    expect(scored.planningCategory).toBe('waiting_on_others');
    expect(scored.recommendedAction).toBe('Nudge Priya — no reply in 5 days.');
  });

  it('maps stale follow-ups directed at the user to follow_up', () => {
    const scored = scoreItem(
      makeItem({
        title: 'Re: contract question',
        bodyText: 'We still need your answer on clause 4 — could you confirm?',
        itemTimestamp: '2026-06-04T08:00:00Z',
      }),
      makeCtx(),
    );
    expect(scored.planningCategory).toBe('follow_up');
    expect(scored.recommendedAction).toContain('Follow up');
  });

  it('maps a long-form low-urgency document to read_when_possible', () => {
    const scored = scoreItem(
      makeItem({
        category: 'upload',
        title: 'Market research report',
        bodyText: 'word '.repeat(1200), // 6000 chars
        sender: null,
      }),
      makeCtx(),
    );
    expect(scored.planningCategory).toBe('read_when_possible');
    expect(scored.recommendedAction).toBe('Set aside 30 minutes to read this.');
  });

  it('maps a low-noise newsletter to low_priority with a safe-to-ignore action', () => {
    const scored = scoreItem(
      makeItem({
        title: 'Weekly Product Newsletter',
        bodyText: 'Industry roundup and updates. Unsubscribe anytime.',
        itemTimestamp: '2026-06-08T02:00:00Z', // 30h old
        isRead: 0,
        sender: { email: 'news@vendor.com' },
      }),
      makeCtx(),
    );
    expect(scored.importance).toBeLessThan(35);
    expect(scored.urgency).toBeLessThan(35);
    expect(scored.planningCategory).toBe('low_priority');
    expect(scored.recommendedAction).toContain('Safe to ignore');
  });
});

describe('scoreItem — output shape, explanation, determinism', () => {
  it('computes overall as round(importance*0.55 + urgency*0.45) and consistent levels', () => {
    const scored = scoreItem(makeItem(), makeCtx());
    expect(scored.overall).toBe(Math.round(scored.importance * 0.55 + scored.urgency * 0.45));
    expect(scored.priorityLevel).toBe(toLevel(scored.overall));
    expect(scored.urgencyLevel).toBe(toLevel(scored.urgency));
    expect(scored.effortLevel).toBe(toLevel(scored.effort));
  });

  it('clamps all scores to 0..100', () => {
    const maxed = scoreItem(
      makeItem({
        title: 'URGENT: Atlas escalation — deadline today, blocked on you',
        bodyText:
          'Critical blocker. Need your approval ASAP. Prepare the analysis deck and coordinate with the external team immediately.',
        dueAt: '2026-06-09T07:00:00Z',
        attachmentCount: 4,
        bodyLength: 5000,
        sender: { email: 'sarah@acme.com' },
        isRead: 0,
      }),
      makeCtx({
        people: [person({ importance: 'vip', interactionCount: 50 })],
        projects: [project()],
        preferences: {
          topicsPrioritize: ['atlas'],
          topicsIgnore: [],
          sourcesPrioritize: ['gmail'],
          sourcesIgnore: [],
        },
        feedback: [{ kind: 'important', senderEmail: 'sarah@acme.com' }],
      }),
    );
    expect(maxed.importance).toBeLessThanOrEqual(100);
    expect(maxed.urgency).toBeLessThanOrEqual(100);
    expect(maxed.effort).toBeLessThanOrEqual(100);
    expect(maxed.overall).toBeLessThanOrEqual(100);
    expect(maxed.importance).toBe(100);
  });

  it('mentions the top signal in the explanation', () => {
    const scored = scoreItem(
      makeItem({ sender: { name: 'Sarah Okafor', email: 'sarah@acme.com' } }),
      makeCtx({ people: [person({ importance: 'vip' })] }),
    );
    expect(scored.explanation).toContain('Sarah Okafor');
    expect(scored.explanation).toContain('key stakeholder');
    expect(scored.explanation).toMatch(/\.$/);
  });

  it('produces a graceful explanation when no rules fire', () => {
    const scored = scoreItem(
      makeItem({ title: 'Notes', bodyText: 'Some plain notes.', sender: null }),
      makeCtx(),
    );
    expect(scored.explanation.length).toBeGreaterThan(0);
  });

  it('is fully deterministic for the same item and now', () => {
    const item = makeItem({
      title: 'Atlas escalation — need your approval',
      bodyText: 'Deadline tomorrow. Please review the deck?',
      dueAt: '2026-06-10T04:00:00Z',
      itemTimestamp: '2026-06-05T08:00:00Z',
      isRead: 0,
    });
    const ctx = makeCtx({
      people: [person()],
      projects: [project()],
      feedback: [{ kind: 'urgent', keywords: ['atlas'] }],
      selfEmails: ['me@acme.com'],
    });
    const a = scoreItem(item, ctx);
    const b = scoreItem(item, ctx);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('applyRefinement', () => {
  const base = scoreItem(makeItem(), makeCtx());

  it('clamps positive and negative deltas to ±15', () => {
    const refined = applyRefinement(base, {
      importanceDelta: 50,
      urgencyDelta: -50,
      effortDelta: 7,
    });
    expect(refined.importance).toBe(Math.min(100, base.importance + 15));
    expect(refined.urgency).toBe(Math.max(0, base.urgency - 15));
    expect(refined.effort).toBe(base.effort + 7);
  });

  it('recomputes overall and levels from refined scores', () => {
    const refined = applyRefinement(base, { importanceDelta: 15, urgencyDelta: 15 });
    expect(refined.overall).toBe(
      Math.round(refined.importance * 0.55 + refined.urgency * 0.45),
    );
    expect(refined.priorityLevel).toBe(toLevel(refined.overall));
    expect(refined.urgencyLevel).toBe(toLevel(refined.urgency));
  });

  it('appends extraSignals without dropping rule signals', () => {
    const extra = { key: 'llm.context_boost', label: 'LLM context boost', weight: 9 };
    const refined = applyRefinement(base, { extraSignals: [extra] });
    expect(refined.signals.length).toBe(base.signals.length + 1);
    expect(refined.signals[refined.signals.length - 1]).toEqual(extra);
  });

  it('prefers refined explanation/action/category when provided', () => {
    const r: LlmScoreRefinement = {
      planningCategory: 'decide',
      explanation: 'The LLM thinks this needs a decision.',
      recommendedAction: 'Decide by Thursday.',
    };
    const refined = applyRefinement(base, r);
    expect(refined.planningCategory).toBe('decide');
    expect(refined.explanation).toBe('The LLM thinks this needs a decision.');
    expect(refined.recommendedAction).toBe('Decide by Thursday.');
  });

  it('keeps base explanation/action when refinement omits or blanks them', () => {
    const refined = applyRefinement(base, { explanation: '   ', recommendedAction: undefined });
    expect(refined.explanation).toBe(base.explanation);
    expect(refined.recommendedAction).toBe(base.recommendedAction);
    expect(refined.planningCategory).toBe(base.planningCategory);
  });

  it('a no-op refinement preserves the base score exactly', () => {
    const refined = applyRefinement(base, {});
    expect(refined).toEqual(base);
  });
});
