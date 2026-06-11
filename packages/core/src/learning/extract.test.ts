import { describe, expect, it } from 'vitest';
import {
  classifyAudience,
  extractActionDecisionSignal,
  extractCalendarDensitySignals,
  extractDraftEditSignals,
  extractExplicitStatementSignals,
  extractFeedbackSignals,
  extractItemSignals,
  extractThreadReplySignals,
  topicSlug,
  type ExtractionContext,
  type LearnableItem,
} from './extract.js';

const NOW = '2026-06-11T12:00:00.000Z';

const ctx: ExtractionContext = {
  now: NOW,
  selfEmails: ['alex@meridian.dev'],
  selfDomains: ['meridian.dev'],
  people: {
    'ceo@meridian.dev': { email: 'ceo@meridian.dev', importance: 'vip', title: 'CEO' },
    'sam@meridian.dev': { email: 'sam@meridian.dev', importance: 'normal', title: 'Engineer' },
    'jane@acme.com': { email: 'jane@acme.com', importance: 'high', title: 'Procurement Lead' },
  },
};

function item(partial: Partial<LearnableItem>): LearnableItem {
  return {
    id: partial.id ?? 'itm_1',
    category: 'email',
    provider: 'gmail',
    title: 'Atlas launch checklist',
    bodyText: null,
    snippet: null,
    sender: null,
    participants: [],
    itemTimestamp: '2026-06-10T09:00:00.000Z',
    dueAt: null,
    startsAt: null,
    threadExternalId: null,
    isRead: 1,
    ...partial,
  };
}

describe('classifyAudience', () => {
  it('classifies by title, domain, and freemail', () => {
    expect(classifyAudience('ceo@meridian.dev', ctx)).toBe('leadership');
    expect(classifyAudience('sam@meridian.dev', ctx)).toBe('team');
    expect(classifyAudience('jane@acme.com', ctx)).toBe('external');
    expect(classifyAudience('friend@gmail.com', ctx)).toBe('personal');
    expect(classifyAudience(undefined, ctx)).toBe('unknown');
  });
});

describe('topicSlug', () => {
  it('strips reply prefixes and stopwords', () => {
    expect(topicSlug('Re: Atlas launch checklist')).toBe('atlas');
    expect(topicSlug('Urgent: please update')).toBeNull();
  });
});

describe('extractItemSignals', () => {
  it('ignores items not authored by the user (revealed preference only)', () => {
    const incoming = item({
      sender: { email: 'jane@acme.com' },
      bodyText: 'Long detailed message '.repeat(50),
    });
    expect(extractItemSignals(incoming, ctx)).toEqual([]);
  });

  it('extracts audience-scoped style signals from self-authored messages', () => {
    const outgoing = item({
      sender: { email: 'alex@meridian.dev' },
      participants: [{ email: 'ceo@meridian.dev' }],
      bodyText: 'Budget approved. Atlas ships Thursday. Vendor risk handled — details in the doc.',
    });
    const signals = extractItemSignals(outgoing, ctx);
    const style = signals.find((s) => s.key === 'style.length');
    expect(style?.value).toBe('concise');
    expect(style?.scope.audience).toBe('leadership');
    expect(style?.source.refId).toBe(outgoing.id);
  });

  it('extracts goal and commitment signals', () => {
    const outgoing = item({
      title: 'Atlas timeline',
      sender: { email: 'alex@meridian.dev' },
      participants: [{ email: 'sam@meridian.dev' }],
      bodyText:
        "Our goal is to ship Atlas by end of quarter. I'll send the revised plan tomorrow morning.",
    });
    const signals = extractItemSignals(outgoing, ctx);
    expect(signals.find((s) => s.kind === 'goal')?.key).toBe('goal.topic:atlas');
    expect(signals.find((s) => s.kind === 'commitment')?.value).toBe('made');
  });

  it('extracts low-strength sentiment signals only', () => {
    const outgoing = item({
      title: 'Vendor migration',
      sender: { email: 'alex@meridian.dev' },
      participants: [{ email: 'sam@meridian.dev' }],
      bodyText: 'This is still broken and I am frustrated we are debugging the vendor sync yet again.',
    });
    const sentiment = extractItemSignals(outgoing, ctx).find((s) => s.kind === 'sentiment');
    expect(sentiment?.value).toBe('negative');
    expect(sentiment?.strength).toBeLessThanOrEqual(0.2);
  });
});

describe('extractThreadReplySignals', () => {
  it('detects fast replies as high-priority person evidence', () => {
    const incoming = item({
      id: 'itm_in',
      threadExternalId: 'th1',
      sender: { email: 'jane@acme.com' },
      participants: [{ email: 'alex@meridian.dev' }],
      itemTimestamp: '2026-06-10T09:00:00.000Z',
    });
    const reply = item({
      id: 'itm_out',
      threadExternalId: 'th1',
      sender: { email: 'alex@meridian.dev' },
      participants: [{ email: 'jane@acme.com' }],
      itemTimestamp: '2026-06-10T09:30:00.000Z',
    });
    const signals = extractThreadReplySignals([incoming, reply], ctx);
    const person = signals.find((s) => s.key === 'person.priority:jane@acme.com');
    expect(person?.value).toBe('high');
    expect(person?.strength).toBe(0.6);
  });

  it('detects loss-framed fast engagement (prospect theory)', () => {
    const incoming = item({
      id: 'itm_risk',
      title: 'Enterprise account churn risk',
      bodyText: 'We may lose the account if the outage is not addressed.',
      threadExternalId: 'th2',
      sender: { email: 'jane@acme.com' },
      participants: [{ email: 'alex@meridian.dev' }],
      itemTimestamp: '2026-06-10T09:00:00.000Z',
    });
    const reply = item({
      id: 'itm_risk_reply',
      threadExternalId: 'th2',
      sender: { email: 'alex@meridian.dev' },
      itemTimestamp: '2026-06-10T09:20:00.000Z',
    });
    const signals = extractThreadReplySignals([incoming, reply], ctx);
    expect(signals.some((s) => s.key === 'risk.attention' && s.value === 'prioritizes_risk')).toBe(true);
  });

  it('records ignored direct messages as weak low-priority evidence', () => {
    const ignored = item({
      id: 'itm_ignored',
      threadExternalId: 'th3',
      sender: { email: 'newsletter@vendor.io' },
      participants: [{ email: 'alex@meridian.dev' }],
      itemTimestamp: '2026-06-01T09:00:00.000Z', // 10 days before NOW, no reply
    });
    const signals = extractThreadReplySignals([ignored], ctx);
    const person = signals.find((s) => s.key === 'person.priority:newsletter@vendor.io');
    expect(person?.value).toBe('low');
    expect(person?.strength).toBeLessThanOrEqual(0.25);
  });
});

describe('extractCalendarDensitySignals', () => {
  it('flags dense days only', () => {
    const dense = Array.from({ length: 7 }, (_, i) =>
      item({
        id: `evt_${i}`,
        category: 'calendar',
        startsAt: `2026-06-10T0${i + 1}:00:00.000Z`,
        itemTimestamp: `2026-06-10T0${i + 1}:00:00.000Z`,
      }),
    );
    const light = item({
      id: 'evt_light',
      category: 'calendar',
      startsAt: '2026-06-12T10:00:00.000Z',
    });
    const signals = extractCalendarDensitySignals([...dense, light], ctx);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.value).toBe('overloaded');
  });
});

describe('extractFeedbackSignals', () => {
  it('maps important feedback to strong person and topic votes', () => {
    const signals = extractFeedbackSignals({
      kind: 'important',
      senderEmail: 'Jane@Acme.com',
      itemTitle: 'Atlas budget approval',
      feedbackId: 'fbk_1',
      observedAt: NOW,
    });
    expect(signals.find((s) => s.key === 'person.priority:jane@acme.com')?.strength).toBe(0.8);
    expect(signals.find((s) => s.key === 'topic.priority:atlas')?.value).toBe('high');
  });

  it('maps done/deferred to no preference vote', () => {
    expect(
      extractFeedbackSignals({ kind: 'done', feedbackId: 'fbk_2', observedAt: NOW }),
    ).toEqual([]);
  });
});

describe('extractActionDecisionSignal', () => {
  it('captures approve/deny as trust evidence', () => {
    const signal = extractActionDecisionSignal({
      capability: 'email.send',
      decision: 'approved',
      refId: 'act_1',
      observedAt: NOW,
    });
    expect(signal.key).toBe('action.trust:email.send');
    expect(signal.value).toBe('approved');
  });
});

describe('extractDraftEditSignals', () => {
  it('turns draft edits into strong audience-scoped style signals', () => {
    const original =
      'Hi Jane, I hope this finds you well. I just wanted to reach out because I was wondering if perhaps we could maybe find time to discuss the budget review, if you get a chance. No worries if not!';
    const edited = 'Jane — can we meet Thursday to align on the budget? 30 minutes.';
    const signals = extractDraftEditSignals({
      original,
      edited,
      audience: 'external',
      channel: 'email',
      observedAt: NOW,
    });
    const length = signals.find((s) => s.key === 'style.length');
    expect(length?.value).toBe('concise');
    expect(length?.strength).toBe(0.7);
    expect(length?.scope).toEqual({ audience: 'external', channel: 'email' });
    expect(length?.source.sourceType).toBe('draft_edit');
  });
});

describe('extractExplicitStatementSignals', () => {
  it('parses style commands at full strength', () => {
    const signals = extractExplicitStatementSignals({
      text: 'Please keep summaries short and use bullet points.',
      observedAt: NOW,
    });
    expect(signals.find((s) => s.key === 'style.length')?.value).toBe('concise');
    expect(signals.find((s) => s.key === 'format.structure')?.value).toBe('bullets');
    expect(signals.every((s) => s.strength === 1)).toBe(true);
  });

  it('parses person and topic priority statements', () => {
    expect(
      extractExplicitStatementSignals({
        text: 'jane@acme.com is high priority',
        observedAt: NOW,
      })[0]?.key,
    ).toBe('person.priority:jane@acme.com');
    expect(
      extractExplicitStatementSignals({
        text: 'the atlas project is my top priority',
        observedAt: NOW,
      })[0]?.key,
    ).toBe('topic.priority:atlas');
  });

  it('ignores free-form text with no structured preference', () => {
    expect(
      extractExplicitStatementSignals({ text: 'remember that I visited Boston', observedAt: NOW }),
    ).toEqual([]);
  });
});
