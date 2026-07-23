import { newId, nowIso, toJson, MIN_ACTIONABLE_CONFIDENCE } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LearningService } from '../context.js';
import { createAuditService } from '../services/audit.js';
import { createLearningService } from '../services/learning.js';
import { createPersonalizationService } from '../services/personalization.js';
import { createSettingsService } from '../services/settings.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let db: Db;
let workspaceId: string;
let userId: string;
let learning: LearningService;

const SELF = 'alex@meridian.dev';

async function seedItem(opts: {
  title: string;
  body?: string;
  category?: 'email' | 'chat' | 'calendar';
  senderEmail?: string;
  participants?: string[];
  thread?: string;
  agoHours?: number;
  startsAt?: string;
}): Promise<string> {
  const id = newId('itm');
  const ts = new Date(Date.now() - (opts.agoHours ?? 1) * HOUR_MS).toISOString();
  await db
    .insertInto('sourceItems')
    .values({
      id,
      workspaceId,
      accountId: 'acc_test',
      provider: opts.category === 'chat' ? 'slack' : 'gmail',
      category: opts.category ?? 'email',
      externalId: id,
      dedupeKey: null,
      title: opts.title,
      bodyText: opts.body ?? null,
      snippet: opts.body?.slice(0, 180) ?? null,
      sender: opts.senderEmail !== undefined ? toJson({ email: opts.senderEmail }) : null,
      participants: toJson((opts.participants ?? []).map((email) => ({ email }))),
      itemTimestamp: ts,
      dueAt: null,
      startsAt: opts.startsAt ?? null,
      endsAt: null,
      url: null,
      threadExternalId: opts.thread ?? null,
      projectIds: '[]',
      peopleIds: '[]',
      labels: '[]',
      rawMetadata: '{}',
      provenance: '{}',
      isRead: 1,
      contentHash: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .execute();
  return id;
}

/** Realistic narrative: Alex writes tersely to the CEO and answers Jane (a key customer) fast. */
async function seedRealisticWorkspace(): Promise<void> {
  // People: CEO (leadership), Jane (external customer).
  const now = nowIso();
  await db
    .insertInto('people')
    .values([
      {
        id: newId('per'),
        workspaceId,
        displayName: 'Morgan Hale',
        emails: toJson(['morgan@meridian.dev']),
        handles: '[]',
        organizationId: null,
        title: 'CEO',
        importance: 'vip',
        isSelf: 0,
        interactionCount: 40,
        lastInteractionAt: now,
        notes: null,
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId('per'),
        workspaceId,
        displayName: 'Alex Chen',
        emails: toJson([SELF]),
        handles: '[]',
        organizationId: null,
        title: 'VP Product',
        importance: 'normal',
        isSelf: 1,
        interactionCount: 0,
        lastInteractionAt: null,
        notes: null,
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      },
    ])
    .execute();

  // Repeated concise, direct messages from Alex to the CEO.
  const conciseBodies = [
    'Budget approved. Atlas ships Thursday. Vendor risk handled — summary attached for the board.',
    'Decision made: we cut scope to hit the date. Risks logged. Will update the board deck tonight.',
    'Hiring plan signed off. Two offers out today. Pipeline review moved to Friday morning.',
    'Atlas launch is green. Support is staffed. Press note goes out at nine sharp tomorrow.',
  ];
  for (let i = 0; i < conciseBodies.length; i += 1) {
    await seedItem({
      title: `Update ${i + 1} for Morgan`,
      body: conciseBodies[i],
      senderEmail: SELF,
      participants: ['morgan@meridian.dev'],
      agoHours: 5 + i * 24,
    });
  }

  // Jane (external customer) raises churn risk; Alex replies within minutes — twice.
  for (let t = 0; t < 2; t += 1) {
    await seedItem({
      title: 'Renewal at risk — escalation',
      body: 'We may cancel the contract if the outage recurs. This is a churn risk for the account.',
      senderEmail: 'jane@acme.com',
      participants: [SELF],
      thread: `risk-${t}`,
      agoHours: 30 + t * 24,
    });
    await seedItem({
      title: 'Re: Renewal at risk — escalation',
      body: 'On it. Root cause identified; fix ships today. I will call you at 3pm with the full plan.',
      senderEmail: SELF,
      participants: ['jane@acme.com'],
      thread: `risk-${t}`,
      agoHours: 29.5 + t * 24,
    });
  }
}

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db, { email: SELF, name: 'Alex Chen' });
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  learning = createLearningService({ db, settings, audit });
});

describe('end-to-end learning from realistic data', () => {
  it('learns audience-scoped style and person priority from synced items', async () => {
    await seedRealisticWorkspace();
    const result = await learning.learnNow(workspaceId);
    expect(result.signals).toBeGreaterThan(4);

    const prefs = await learning.list(workspaceId, userId, { includeInactive: true });
    const style = prefs.find((p) => p.key === 'style.length');
    expect(style).toBeDefined();
    expect(style?.value).toBe('concise');
    expect(style?.scope.audience).toBe('leadership');
    expect(style?.origin).toBe('inferred');
    expect(style?.explanation).toContain('observation');
    expect(style?.sources.length).toBeGreaterThan(0);

    const jane = prefs.find((p) => p.key === 'person.priority:jane@acme.com');
    expect(jane?.value).toBe('high');

    const risk = prefs.find((p) => p.key === 'risk.attention');
    expect(risk?.value).toBe('prioritizes_risk');
  });

  it('is idempotent: re-running learning does not double-count evidence', async () => {
    await seedRealisticWorkspace();
    await learning.learnNow(workspaceId);
    const before = await learning.list(workspaceId, userId, { includeInactive: true });
    await learning.learnNow(workspaceId);
    const after = await learning.list(workspaceId, userId, { includeInactive: true });
    expect(after.length).toBe(before.length);
    for (const pref of after) {
      const prior = before.find((p) => p.id === pref.id);
      expect(pref.evidenceCount).toBe(prior?.evidenceCount);
    }
  });

  it('audits learning runs and preference creation (no hidden profiling)', async () => {
    await seedRealisticWorkspace();
    await learning.learnNow(workspaceId);
    const audits = await db.selectFrom('auditLogs').selectAll().execute();
    expect(audits.some((a) => a.eventType === 'learning.run')).toBe(true);
    expect(audits.some((a) => a.eventType === 'learning.preference.created')).toBe(true);
  });
});

describe('privacy: sensitive inferences are never stored', () => {
  it('drops signals whose content touches sensitive attributes', async () => {
    await seedRealisticWorkspace();
    // A health-related thread Alex replies to quickly — must NOT be learned.
    await seedItem({
      title: 'Oncology appointment follow-up',
      body: 'Your chemotherapy schedule and diagnosis results are attached.',
      senderEmail: 'clinic@hospital.org',
      participants: [SELF],
      thread: 'health-1',
      agoHours: 10,
    });
    await seedItem({
      title: 'Re: Oncology appointment follow-up',
      body: 'Thank you, I will be there.',
      senderEmail: SELF,
      participants: ['clinic@hospital.org'],
      thread: 'health-1',
      agoHours: 9.8,
    });
    await learning.learnNow(workspaceId);

    const signals = await db.selectFrom('learningSignals').selectAll().execute();
    const leaked = signals.filter(
      (s) =>
        (s.detail ?? '').toLowerCase().includes('chemo') ||
        (s.detail ?? '').toLowerCase().includes('oncology') ||
        s.key.includes('oncology'),
    );
    expect(leaked).toEqual([]);

    const prefs = await learning.list(workspaceId, userId, { includeInactive: true });
    expect(prefs.some((p) => p.statement.toLowerCase().includes('oncology'))).toBe(false);
  });

  it('refuses explicit statements about sensitive attributes', async () => {
    await expect(
      learning.createExplicit(workspaceId, userId, {
        statement: 'Remember that I am undergoing chemotherapy treatment',
      }),
    ).rejects.toThrow(/sensitive/i);
  });
});

describe('explicit feedback and overrides', () => {
  it('learnFromFeedback stores high-weight evidence that becomes actionable fast', async () => {
    await learning.learnFromFeedback(workspaceId, userId, {
      kind: 'important',
      senderEmail: 'jane@acme.com',
      itemTitle: 'Renewal discussion',
      feedbackId: 'fbk_1',
      observedAt: nowIso(),
    });
    await learning.learnFromFeedback(workspaceId, userId, {
      kind: 'important',
      senderEmail: 'jane@acme.com',
      itemTitle: 'Renewal discussion next steps',
      feedbackId: 'fbk_2',
      observedAt: nowIso(),
    });
    await learning.runInference(workspaceId);
    const prefs = await learning.list(workspaceId, userId);
    const jane = prefs.find((p) => p.key === 'person.priority:jane@acme.com');
    expect(jane?.origin).toBe('feedback');
    expect(jane?.confidence ?? 0).toBeGreaterThanOrEqual(MIN_ACTIONABLE_CONFIDENCE);
  });

  it('learnFromText applies explicit commands immediately', async () => {
    const stored = await learning.learnFromText(workspaceId, userId, {
      text: 'Please keep summaries short, and jane@acme.com is high priority.',
      observedAt: nowIso(),
    });
    expect(stored).toBe(2);
    const prefs = await learning.list(workspaceId, userId);
    expect(prefs.find((p) => p.key === 'style.length')?.origin).toBe('explicit');
    expect(prefs.find((p) => p.key === 'person.priority:jane@acme.com')?.value).toBe('high');
  });

  it('an explicit statement overrides behavior learned the other way', async () => {
    await seedRealisticWorkspace();
    await learning.learnNow(workspaceId);
    // Behavior says concise-to-leadership; the user now says detailed.
    await learning.learnFromText(workspaceId, userId, {
      text: 'Actually, prefer more detail in everything you write for me.',
      observedAt: nowIso(),
    });
    const prefs = await learning.list(workspaceId, userId);
    const explicitDetail = prefs.find((p) => p.key === 'style.length' && p.origin === 'explicit');
    expect(explicitDetail?.value).toBe('detailed');
  });

  it('learnFromDraftEdit stores strong style signals', async () => {
    const stored = await learning.learnFromDraftEdit(workspaceId, userId, {
      original:
        'Hi Jane, I hope this message finds you well. I just wanted to reach out because I was wondering if perhaps we could possibly find some time to discuss the quarterly budget review, if you get a chance. No worries if not, whenever works for you is fine with me!',
      edited: 'Jane — can we meet Thursday to align on the Q3 budget? 30 minutes.',
      audience: 'external',
      channel: 'email',
      observedAt: nowIso(),
    });
    expect(stored).toBeGreaterThanOrEqual(2); // length + directness
    const signals = await db.selectFrom('learningSignals').selectAll().execute();
    expect(signals.every((s) => s.strength === 0.7)).toBe(true);
  });
});

describe('user corrections (the user is the authority)', () => {
  async function learnedStylePref(): Promise<string> {
    await seedRealisticWorkspace();
    await learning.learnNow(workspaceId);
    const prefs = await learning.list(workspaceId, userId);
    const style = prefs.find((p) => p.key === 'style.length');
    expect(style).toBeDefined();
    return style?.id ?? '';
  }

  it('confirm upgrades origin to explicit and boosts confidence', async () => {
    const id = await learnedStylePref();
    const updated = await learning.applyUserCorrection(workspaceId, userId, id, {
      action: 'confirm',
    });
    expect(updated?.origin).toBe('explicit');
    expect(updated?.confidence ?? 0).toBeGreaterThanOrEqual(0.9);
  });

  it('mark_wrong rejects the preference and behavior cannot re-learn it', async () => {
    const id = await learnedStylePref();
    const rejected = await learning.applyUserCorrection(workspaceId, userId, id, {
      action: 'mark_wrong',
    });
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.confidence).toBe(0);

    // More of the same behavior arrives; the rejected preference must stay rejected.
    await seedItem({
      title: 'Another terse update',
      body: 'Ship it today. Brief the team. Flag blockers to me directly by five.',
      senderEmail: SELF,
      participants: ['morgan@meridian.dev'],
      agoHours: 0.5,
    });
    await learning.learnNow(workspaceId);
    const after = await learning.get(workspaceId, id);
    expect(after?.status).toBe('rejected');
  });

  it('pin exempts from decay; edit rewrites the statement at explicit origin', async () => {
    const id = await learnedStylePref();
    const pinned = await learning.applyUserCorrection(workspaceId, userId, id, { action: 'pin' });
    expect(pinned?.pinned).toBe(1);

    const edited = await learning.applyUserCorrection(workspaceId, userId, id, {
      action: 'edit',
      statement: 'Keep leadership updates under five sentences',
    });
    expect(edited?.statement).toBe('Keep leadership updates under five sentences');
    expect(edited?.origin).toBe('explicit');
  });

  it('delete removes the preference and its evidence trail', async () => {
    const id = await learnedStylePref();
    const before = await db.selectFrom('learningSignals').selectAll().execute();
    expect(before.some((s) => s.key === 'style.length')).toBe(true);
    await learning.applyUserCorrection(workspaceId, userId, id, { action: 'delete' });
    expect(await learning.get(workspaceId, id)).toBeNull();
    const signals = await db.selectFrom('learningSignals').selectAll().execute();
    expect(signals.some((s) => s.key === 'style.length')).toBe(false);
  });

  it('rejects sensitive content in edits', async () => {
    const id = await learnedStylePref();
    await expect(
      learning.applyUserCorrection(workspaceId, userId, id, {
        action: 'edit',
        statement: 'I always vote for the republican candidate',
      }),
    ).rejects.toThrow(/sensitive/i);
  });
});

describe('decay and retirement', () => {
  it('decays unreinforced preferences and retires them below the threshold', async () => {
    await learning.learnFromText(workspaceId, userId, {
      text: 'keep replies short',
      observedAt: nowIso(),
    });
    const prefs = await learning.list(workspaceId, userId);
    const pref = prefs[0]!;

    // Simulate a weak inferred preference last reinforced 2 years ago.
    const longAgo = new Date(Date.now() - 730 * DAY_MS).toISOString();
    await db
      .updateTable('learnedPreferences')
      .set({ origin: 'inferred', confidence: 0.5, lastReinforcedAt: longAgo, decayHalfLifeDays: 90 })
      .where('id', '=', pref.id)
      .execute();

    const result = await learning.decayConfidence(workspaceId);
    expect(result.decayed).toBe(1);
    expect(result.retired).toBe(1);
    const after = await learning.get(workspaceId, pref.id);
    expect(after?.status).toBe('retired');
  });

  it('never auto-retires pinned or explicit preferences', async () => {
    await learning.learnFromText(workspaceId, userId, {
      text: 'keep replies short',
      observedAt: nowIso(),
    });
    const pref = (await learning.list(workspaceId, userId))[0]!;
    const longAgo = new Date(Date.now() - 730 * DAY_MS).toISOString();
    await db
      .updateTable('learnedPreferences')
      .set({ lastReinforcedAt: longAgo })
      .where('id', '=', pref.id)
      .execute();
    await learning.decayConfidence(workspaceId);
    const after = await learning.get(workspaceId, pref.id);
    expect(after?.status).toBe('active'); // explicit origin: decays but never retires
  });
});

describe('explain, search, context lookup', () => {
  it('explain returns the preference with its recent supporting signals', async () => {
    await seedRealisticWorkspace();
    await learning.learnNow(workspaceId);
    const pref = (await learning.list(workspaceId, userId)).find(
      (p) => p.key === 'style.length',
    )!;
    const explained = await learning.explain(workspaceId, pref.id);
    expect(explained.preference.id).toBe(pref.id);
    expect(explained.recentSignals.length).toBeGreaterThan(0);
    expect(explained.recentSignals.every((s) => s.key === 'style.length')).toBe(true);
  });

  it('search finds preferences by statement keywords', async () => {
    await learning.learnFromText(workspaceId, userId, {
      text: 'jane@acme.com is high priority',
      observedAt: nowIso(),
    });
    const hits = await learning.search(workspaceId, userId, 'jane@acme.com');
    expect(hits.length).toBe(1);
    expect(await learning.search(workspaceId, userId, 'nonexistent')).toEqual([]);
  });

  it('getPreferencesByContext returns scope-matching preferences, most specific last', async () => {
    await seedRealisticWorkspace();
    await learning.learnNow(workspaceId);
    const leadership = await learning.getPreferencesByContext(workspaceId, userId, {
      audience: 'leadership',
      channel: 'email',
    });
    expect(leadership.some((p) => p.key === 'style.length')).toBe(true);
    // The leadership style preference must not apply in a personal context.
    const personal = await learning.getPreferencesByContext(workspaceId, userId, {
      audience: 'personal',
    });
    expect(personal.some((p) => p.key === 'style.length')).toBe(false);
  });
});

describe('learning disabled', () => {
  it('stores nothing when learning is disabled', async () => {
    const settings = createSettingsService({ db });
    await settings.set(workspaceId, 'learning.enabled', false);
    await seedRealisticWorkspace();
    const result = await learning.learnNow(workspaceId);
    expect(result.signals).toBe(0);
    expect(result.created).toBe(0);
    expect(
      await learning.learnFromText(workspaceId, userId, {
        text: 'keep replies short',
        observedAt: nowIso(),
      }),
    ).toBe(0);
    const signals = await db.selectFrom('learningSignals').selectAll().execute();
    expect(signals).toEqual([]);
  });
});

describe('personalization service', () => {
  it('personalizes a leadership email draft using learned style and explains why', async () => {
    await seedRealisticWorkspace();
    await learning.learnNow(workspaceId);
    // Reinforce with explicit confirmation so it is actionable regardless of count.
    const pref = (await learning.list(workspaceId, userId)).find((p) => p.key === 'style.length')!;
    await learning.applyUserCorrection(workspaceId, userId, pref.id, { action: 'confirm' });

    const personalization = createPersonalizationService({ db, learning });
    const result = await personalization.forTask(workspaceId, userId, {
      task: 'email_draft',
      audience: 'leadership',
      channel: 'email',
    });
    expect(result.config.verbosity).toBe('concise');
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.every((a) => a.reason.length > 0)).toBe(true);

    // Outside the learned scope the style preference is not applied.
    const personal = await personalization.forTask(workspaceId, userId, {
      task: 'email_draft',
      audience: 'personal',
    });
    expect(personal.applied.some((a) => a.preferenceId === pref.id)).toBe(false);
  });

  it('tightens digest output when the next 24h calendar is dense', async () => {
    for (let i = 0; i < 6; i += 1) {
      await seedItem({
        title: `Meeting ${i}`,
        category: 'calendar',
        startsAt: new Date(Date.now() + (i + 1) * HOUR_MS).toISOString(),
        agoHours: 1,
      });
    }
    const personalization = createPersonalizationService({ db, learning });
    const result = await personalization.forTask(workspaceId, userId, { task: 'digest' });
    expect(result.config.verbosity).toBe('concise');
    expect(result.config.maxItemsPerSection).toBe(5);
  });
});
