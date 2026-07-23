import { fromJson, newId, nowIso, toJson } from '@jarvis/core';
import type { Db, SourceItemsTable } from '@jarvis/db';
import { createMockAdapter, LlmClient } from '@jarvis/llm';
import { describe, expect, it } from 'vitest';
import type { LlmRouterService, RoutedLlm } from '../context.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createScoringService, extractTitleKeywords, FEEDBACK_PREF_KEYS } from './scoring.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isoFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function stubLlm(): LlmRouterService {
  const routed: RoutedLlm = {
    client: new LlmClient(createMockAdapter()),
    model: 'mock',
    params: {},
    providerConfigId: null,
    providerName: 'Demo (mock)',
    kind: 'mock',
    isLocal: true,
    isMock: true,
  };
  return {
    async clientForTask() {
      return routed;
    },
    async embeddingClient() {
      return null;
    },
    async healthCheck() {
      return { ok: true, latencyMs: 0, message: 'mock' };
    },
    async listModels() {
      return [];
    },
    async status() {
      return {
        demoMode: true,
        tasks: { chat: null, summarization: null, digest: null, classification: null, embedding: null },
      };
    },
  };
}

async function insertSourceItem(
  db: Db,
  workspaceId: string,
  overrides: Partial<SourceItemsTable> = {},
): Promise<string> {
  const id = newId('itm');
  const now = nowIso();
  await db
    .insertInto('sourceItems')
    .values({
      id,
      workspaceId,
      accountId: 'acc_test',
      provider: 'mock-email',
      category: 'email',
      externalId: id,
      dedupeKey: null,
      title: 'Quarterly budget review',
      bodyText: 'Please review the quarterly budget numbers.',
      snippet: 'Please review the quarterly budget numbers.',
      sender: toJson({ name: 'Jin Park', email: 'jin@meridianlabs.example' }),
      participants: toJson([]),
      itemTimestamp: isoAgo(2 * HOUR_MS),
      dueAt: null,
      startsAt: null,
      endsAt: null,
      url: null,
      threadExternalId: null,
      projectIds: toJson([]),
      peopleIds: toJson([]),
      labels: toJson([]),
      rawMetadata: toJson({}),
      provenance: toJson({}),
      isRead: 0,
      contentHash: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .execute();
  return id;
}

function makeService(db: Db) {
  return createScoringService({ db, llm: stubLlm(), audit: createAuditService({ db }) });
}

describe('extractTitleKeywords', () => {
  it('extracts up to 3 distinct meaningful keywords', () => {
    expect(extractTitleKeywords('Quarterly budget forecast review draft')).toEqual([
      'quarterly',
      'budget',
      'forecast',
    ]);
    expect(extractTitleKeywords('Re: a an it')).toEqual([]);
  });
});

describe('scoring.buildContext', () => {
  it('collects people, projects, preferences, self emails, and feedback signals', async () => {
    const db = await createTestDb();
    const { workspaceId, userId } = await seedWorkspace(db, { email: 'me@jarvis.example' });
    const now = nowIso();

    await db
      .insertInto('people')
      .values([
        {
          id: newId('per'),
          workspaceId,
          displayName: 'Me',
          emails: toJson(['me-alias@jarvis.example']),
          handles: toJson(['@me']),
          organizationId: null,
          title: null,
          importance: 'normal',
          isSelf: 1,
          interactionCount: 0,
          lastInteractionAt: null,
          notes: null,
          origin: 'user',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: newId('per'),
          workspaceId,
          displayName: 'Sarah Chen',
          emails: toJson(['sarah@meridianlabs.example']),
          handles: toJson([]),
          organizationId: null,
          title: 'CEO',
          importance: 'vip',
          isSelf: 0,
          interactionCount: 25,
          lastInteractionAt: null,
          notes: null,
          origin: 'connector',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .execute();

    await db
      .insertInto('projects')
      .values({
        id: newId('prj'),
        workspaceId,
        name: 'Apollo Launch',
        description: null,
        status: 'active',
        priority: 'high',
        keywords: toJson(['apollo', 'launch']),
        stakeholderPeopleIds: toJson([]),
        dueAt: null,
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const prefRows = [
      { key: 'topics.prioritize', value: toJson(['security']) },
      { key: 'topics.ignore', value: toJson(['newsletter']) },
      { key: 'sources.prioritize', value: toJson(['mock-email']) },
      { key: 'workingHours', value: toJson({ start: '09:00', end: '18:00' }) },
      { key: FEEDBACK_PREF_KEYS.topicsMoreLikeThis, value: toJson(['budget']) },
      { key: FEEDBACK_PREF_KEYS.sendersImportant, value: toJson(['sarah@meridianlabs.example']) },
      { key: FEEDBACK_PREF_KEYS.sendersNotImportant, value: toJson(['spam@example.com']) },
    ];
    await db
      .insertInto('userPreferences')
      .values(
        prefRows.map((p) => ({
          id: newId('prf'),
          workspaceId,
          userId,
          key: p.key,
          value: p.value,
          kind: 'explicit',
          origin: 'user',
          createdAt: now,
          updatedAt: now,
        })),
      )
      .execute();

    const itemId = await insertSourceItem(db, workspaceId, {
      title: 'Vendor contract renewal terms',
      sender: toJson({ email: 'vendor@acme.example' }),
    });
    await db
      .insertInto('itemFeedback')
      .values({
        id: newId('fbk'),
        workspaceId,
        userId,
        sourceItemId: itemId,
        taskCandidateId: null,
        digestItemId: null,
        kind: 'important',
        note: null,
        createdAt: now,
      })
      .execute();

    const service = makeService(db);
    const ctx = await service.buildContext(workspaceId, now);

    expect(ctx.now).toBe(now);
    expect(ctx.selfEmails).toContain('me@jarvis.example');
    expect(ctx.selfEmails).toContain('me-alias@jarvis.example');

    const sarah = ctx.people.find((p) => p.displayName === 'Sarah Chen');
    expect(sarah).toMatchObject({
      importance: 'vip',
      emails: ['sarah@meridianlabs.example'],
      interactionCount: 25,
    });

    expect(ctx.projects).toHaveLength(1);
    expect(ctx.projects[0]).toMatchObject({
      name: 'Apollo Launch',
      priority: 'high',
      keywords: ['apollo', 'launch'],
    });

    expect(ctx.preferences.topicsPrioritize).toEqual(expect.arrayContaining(['security', 'budget']));
    expect(ctx.preferences.topicsIgnore).toEqual(['newsletter']);
    expect(ctx.preferences.sourcesPrioritize).toEqual(['mock-email']);
    expect(ctx.preferences.workingHoursStart).toBe('09:00');
    expect(ctx.preferences.workingHoursEnd).toBe('18:00');

    // Feedback row joined to its source item.
    const fromItem = ctx.feedback.find((f) => f.senderEmail === 'vendor@acme.example');
    expect(fromItem).toBeDefined();
    expect(fromItem!.kind).toBe('important');
    expect(fromItem!.category).toBe('email');
    expect(fromItem!.keywords).toEqual(['vendor', 'contract', 'renewal']);
    // Derived sender preferences become standing signals.
    expect(
      ctx.feedback.some((f) => f.kind === 'important' && f.senderEmail === 'sarah@meridianlabs.example'),
    ).toBe(true);
    expect(
      ctx.feedback.some((f) => f.kind === 'not_important' && f.senderEmail === 'spam@example.com'),
    ).toBe(true);
  });
});

describe('scoring.rescoreWorkspace', () => {
  it('creates task candidates for recent items and updates them idempotently', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const itemA = await insertSourceItem(db, workspaceId, {
      title: 'URGENT: production blocker needs your sign-off',
      dueAt: isoFromNow(3 * HOUR_MS),
    });
    const itemB = await insertSourceItem(db, workspaceId, { title: 'Weekly metrics summary' });
    const service = makeService(db);

    const first = await service.rescoreWorkspace(workspaceId);
    expect(first.scored).toBe(2);

    const tasks = await db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(tasks).toHaveLength(2);
    const taskA = tasks.find((t) => t.sourceItemId === itemA);
    expect(taskA).toBeDefined();
    expect(taskA!.origin).toBe('scoring');
    expect(taskA!.status).toBe('open');
    expect(taskA!.overallScore).toBeGreaterThan(0);
    expect(taskA!.dueAt).not.toBeNull();
    expect(taskA!.explanation).toBeTruthy();
    expect(taskA!.recommendedAction).toBeTruthy();
    const signals = fromJson<Array<{ key: string }>>(taskA!.signals, []);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some((s) => s.key.includes('escalation'))).toBe(true);

    // Re-running keeps the same rows (stable per sourceItemId + origin).
    const second = await service.rescoreWorkspace(workspaceId);
    expect(second.scored).toBe(2);
    const again = await db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(again).toHaveLength(2);
    expect(new Set(again.map((t) => t.id))).toEqual(new Set(tasks.map((t) => t.id)));
    expect(again.find((t) => t.sourceItemId === itemB)!.status).toBe('open');
  });

  it('never overwrites a user-set status (done/deferred/dismissed)', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const itemId = await insertSourceItem(db, workspaceId);
    const service = makeService(db);
    await service.rescoreWorkspace(workspaceId);

    const task = await db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirstOrThrow();
    expect(task.sourceItemId).toBe(itemId);
    await db
      .updateTable('taskCandidates')
      .set({ status: 'done', explanation: 'stale explanation' })
      .where('id', '=', task.id)
      .execute();

    await service.rescoreWorkspace(workspaceId);
    const after = await db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('done'); // user status preserved
    expect(after.explanation).not.toBe('stale explanation'); // scores/explanation refreshed
  });

  it('skips old items unless they have a future dueAt/startsAt', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await insertSourceItem(db, workspaceId, {
      title: 'Ancient thread',
      itemTimestamp: isoAgo(30 * DAY_MS),
    });
    const upcoming = await insertSourceItem(db, workspaceId, {
      title: 'Old item with upcoming deadline',
      itemTimestamp: isoAgo(30 * DAY_MS),
      dueAt: isoFromNow(2 * DAY_MS),
    });
    const service = makeService(db);

    const result = await service.rescoreWorkspace(workspaceId);
    expect(result.scored).toBe(1);
    const tasks = await db
      .selectFrom('taskCandidates')
      .select(['sourceItemId'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(tasks.map((t) => t.sourceItemId)).toEqual([upcoming]);
  });
});
