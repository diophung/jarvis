import { fromJson, newId, nowIso, toJson } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { describe, expect, it } from 'vitest';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createFeedbackService } from './feedback.js';
import { FEEDBACK_PREF_KEYS } from './scoring.js';

const DAY_MS = 86_400_000;

async function insertSourceItem(
  db: Db,
  workspaceId: string,
  opts: { title?: string; senderEmail?: string | null } = {},
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
      title: opts.title ?? 'Quarterly budget forecast review',
      bodyText: 'body',
      snippet: 'snippet',
      sender:
        opts.senderEmail === null
          ? null
          : toJson({ name: 'Sender', email: opts.senderEmail ?? 'bob@acme.example' }),
      participants: toJson([]),
      itemTimestamp: now,
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
    })
    .execute();
  return id;
}

async function insertTask(
  db: Db,
  workspaceId: string,
  opts: { sourceItemId?: string | null; deferredUntil?: string | null } = {},
): Promise<string> {
  const id = newId('tsk');
  const now = nowIso();
  await db
    .insertInto('taskCandidates')
    .values({
      id,
      workspaceId,
      sourceItemId: opts.sourceItemId ?? null,
      title: 'A task',
      description: null,
      status: 'open',
      dueAt: null,
      deferredUntil: opts.deferredUntil ?? null,
      importanceScore: 50,
      urgencyScore: 50,
      effortScore: 20,
      overallScore: 50,
      priorityLevel: 'medium',
      urgencyLevel: 'medium',
      effortLevel: 'low',
      planningCategory: 'follow_up',
      signals: toJson([]),
      explanation: 'why',
      recommendedAction: 'do it',
      projectId: null,
      peopleIds: toJson([]),
      origin: 'scoring',
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

async function getPref(db: Db, workspaceId: string, key: string) {
  return db
    .selectFrom('userPreferences')
    .selectAll()
    .where('workspaceId', '=', workspaceId)
    .where('key', '=', key)
    .executeTakeFirst();
}

function makeService(db: Db) {
  return createFeedbackService({ db, audit: createAuditService({ db }) });
}

describe('feedback service', () => {
  it('records the feedback row and audits it', async () => {
    const db = await createTestDb();
    const { workspaceId, userId } = await seedWorkspace(db);
    const itemId = await insertSourceItem(db, workspaceId);
    const service = makeService(db);

    await service.record(workspaceId, userId, { kind: 'incorrect', sourceItemId: itemId, note: 'wrong' });

    const rows = await db.selectFrom('itemFeedback').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'incorrect', sourceItemId: itemId, note: 'wrong', userId });

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'feedback.recorded')
      .execute();
    expect(audits).toHaveLength(1);

    // 'incorrect' has no side effects.
    expect(await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.sendersImportant)).toBeUndefined();
    expect(await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.topicsMoreLikeThis)).toBeUndefined();
  });

  it('done marks the task done; deferred sets deferredUntil to +1 day when none provided', async () => {
    const db = await createTestDb();
    const { workspaceId, userId } = await seedWorkspace(db);
    const doneTask = await insertTask(db, workspaceId);
    const deferTask = await insertTask(db, workspaceId);
    const presetUntil = new Date(Date.now() + 7 * DAY_MS).toISOString();
    const presetTask = await insertTask(db, workspaceId, { deferredUntil: presetUntil });
    const service = makeService(db);

    await service.record(workspaceId, userId, { kind: 'done', taskCandidateId: doneTask });
    const before = Date.now();
    await service.record(workspaceId, userId, { kind: 'deferred', taskCandidateId: deferTask });
    await service.record(workspaceId, userId, { kind: 'deferred', taskCandidateId: presetTask });

    const tasks = await db.selectFrom('taskCandidates').selectAll().execute();
    expect(tasks.find((t) => t.id === doneTask)!.status).toBe('done');

    const deferred = tasks.find((t) => t.id === deferTask)!;
    expect(deferred.status).toBe('deferred');
    expect(deferred.deferredUntil).not.toBeNull();
    const until = Date.parse(deferred.deferredUntil!);
    expect(until).toBeGreaterThanOrEqual(before + DAY_MS - 5000);
    expect(until).toBeLessThanOrEqual(Date.now() + DAY_MS + 5000);

    // An existing deferredUntil is kept.
    const preset = tasks.find((t) => t.id === presetTask)!;
    expect(preset.status).toBe('deferred');
    expect(preset.deferredUntil).toBe(presetUntil);
  });

  it('important / not_important maintain disjoint derived sender arrays', async () => {
    const db = await createTestDb();
    const { workspaceId, userId } = await seedWorkspace(db);
    const itemId = await insertSourceItem(db, workspaceId, { senderEmail: 'Bob@Acme.example' });
    const taskId = await insertTask(db, workspaceId, { sourceItemId: itemId });
    const service = makeService(db);

    // Important via the task candidate (resolves to its source item's sender).
    await service.record(workspaceId, userId, { kind: 'important', taskCandidateId: taskId });
    let important = await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.sendersImportant);
    expect(important).toBeDefined();
    expect(important!.kind).toBe('derived');
    expect(important!.origin).toBe('feedback');
    expect(fromJson<string[]>(important!.value, [])).toEqual(['bob@acme.example']);

    // Recording again does not duplicate.
    await service.record(workspaceId, userId, { kind: 'important', sourceItemId: itemId });
    important = await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.sendersImportant);
    expect(fromJson<string[]>(important!.value, [])).toEqual(['bob@acme.example']);

    // Flipping to not_important moves the email; arrays stay disjoint.
    await service.record(workspaceId, userId, { kind: 'not_important', sourceItemId: itemId });
    important = await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.sendersImportant);
    const notImportant = await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.sendersNotImportant);
    expect(fromJson<string[]>(important!.value, [])).toEqual([]);
    expect(fromJson<string[]>(notImportant!.value, [])).toEqual(['bob@acme.example']);
  });

  it('more_like_this appends top title keywords to the derived topics list', async () => {
    const db = await createTestDb();
    const { workspaceId, userId } = await seedWorkspace(db);
    const itemId = await insertSourceItem(db, workspaceId, {
      title: 'Quarterly budget forecast review',
    });
    const service = makeService(db);

    await service.record(workspaceId, userId, { kind: 'more_like_this', sourceItemId: itemId });
    const pref = await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.topicsMoreLikeThis);
    expect(pref).toBeDefined();
    expect(fromJson<string[]>(pref!.value, [])).toEqual(['quarterly', 'budget', 'forecast']);

    // Idempotent for the same keywords.
    await service.record(workspaceId, userId, { kind: 'more_like_this', sourceItemId: itemId });
    const again = await getPref(db, workspaceId, FEEDBACK_PREF_KEYS.topicsMoreLikeThis);
    expect(fromJson<string[]>(again!.value, [])).toEqual(['quarterly', 'budget', 'forecast']);
  });
});
