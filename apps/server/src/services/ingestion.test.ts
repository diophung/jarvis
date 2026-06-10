import { createDefaultRegistry, createDemoDataset } from '@donna/connectors';
import { fromJson, newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import { describe, expect, it } from 'vitest';
import type { IndexingService } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createIngestionService } from './ingestion.js';
import { createSecretsService } from './secrets.js';
import { createSettingsService } from './settings.js';

/** Pin the mock connectors' clock so the demo dataset is deterministic. */
const DEMO_NOW = '2026-06-08T09:00:00.000Z';

interface IndexingStub extends IndexingService {
  calls: Array<{ refId: string; text: string; sourceLabel?: string }>;
}

function stubIndexing(): IndexingStub {
  const calls: IndexingStub['calls'] = [];
  return {
    calls,
    async indexText(_workspaceId, _sourceType, refId, text, metadata) {
      calls.push({ refId, text, sourceLabel: metadata.sourceLabel });
      return { chunks: 1, embedded: false };
    },
    async removeIndex() {},
  };
}

async function insertAccount(
  db: Db,
  workspaceId: string,
  userId: string,
  provider: string,
  opts: { category?: string; lastSyncAt?: string | null } = {},
): Promise<string> {
  const id = newId('acc');
  const now = nowIso();
  await db
    .insertInto('sourceAccounts')
    .values({
      id,
      workspaceId,
      userId,
      provider,
      category: opts.category ?? 'email',
      displayName: `${provider} account`,
      status: 'connected',
      authRef: null,
      scopes: toJson([]),
      capabilities: toJson([]),
      settings: toJson({ demoNow: DEMO_NOW }),
      lastSyncAt: opts.lastSyncAt ?? null,
      syncCursor: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

function makeService(db: Db) {
  const indexing = stubIndexing();
  const service = createIngestionService({
    db,
    connectors: createDefaultRegistry(),
    secrets: createSecretsService({ appSecret: 'test-secret' }),
    audit: createAuditService({ db }),
    settings: createSettingsService({ db }),
    indexing,
  });
  return { service, indexing };
}

describe('ingestion service', () => {
  it('full sync of mock-email inserts parsed items, attachments, people and records the run', async () => {
    const db = await createTestDb();
    const { userId, workspaceId } = await seedWorkspace(db);
    const accountId = await insertAccount(db, workspaceId, userId, 'mock-email');
    const { service, indexing } = makeService(db);
    const dataset = createDemoDataset(new Date(DEMO_NOW));

    const run = await service.syncAccount(workspaceId, accountId, {
      mode: 'full',
      triggeredBy: 'manual',
    });

    expect(run.status).toBe('success');
    expect(run.mode).toBe('full');
    expect(run.triggeredBy).toBe('manual');
    expect(run.itemsSeen).toBe(dataset.emails.length);
    expect(run.itemsCreated).toBe(dataset.emails.length);
    expect(run.itemsUpdated).toBe(0);
    expect(run.errorCount).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.completedAt).not.toBeNull();
    expect(run.cursorAfter).toMatch(/^synced:\d+$/);

    // Items inserted with parsed fields + provenance pointing at the run.
    const items = await db
      .selectFrom('sourceItems')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(items).toHaveLength(dataset.emails.length);
    const msaEmail = items.find((i) => i.externalId === 'demo-email-001');
    expect(msaEmail).toBeDefined();
    expect(fromJson(msaEmail!.sender, null)).toMatchObject({
      email: 'jin.park@meridianlabs.com',
    });
    expect(msaEmail!.snippet).toBeTruthy();
    expect(msaEmail!.contentHash).toBeTruthy();
    expect(msaEmail!.dedupeKey).toBeTruthy();
    expect(fromJson(msaEmail!.provenance, {})).toEqual({ connectorRunId: run.id });

    // Attachment rows for items that carry attachments.
    const attachments = await db
      .selectFrom('sourceAttachments')
      .selectAll()
      .where('itemId', '=', msaEmail!.id)
      .execute();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe('Northwind-MSA-v4-redline.docx');

    // People observed from senders/participants with interaction counts.
    const people = await db
      .selectFrom('people')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(people.length).toBeGreaterThan(0);
    const jin = people.find((p) =>
      fromJson<string[]>(p.emails, []).includes('jin.park@meridianlabs.com'),
    );
    expect(jin).toBeDefined();
    expect(jin!.origin).toBe('observed');
    expect(jin!.displayName).toBe('Jin Park');
    expect(jin!.interactionCount).toBeGreaterThanOrEqual(1);
    expect(jin!.lastInteractionAt).toBeTruthy();

    // Cursor + status saved on the account.
    const account = await db
      .selectFrom('sourceAccounts')
      .selectAll()
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(account.lastSyncAt).not.toBeNull();
    expect(account.syncCursor).toBe(run.cursorAfter);
    expect(account.status).toBe('connected');

    // Every new item was indexed with the account display name as label.
    expect(indexing.calls).toHaveLength(dataset.emails.length);
    expect(indexing.calls[0]?.sourceLabel).toBe('mock-email account');

    // Audited.
    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('eventType', '=', 'connector.sync')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(accountId);
  });

  it('incremental sync uses the saved cursor: new arrivals only, then nothing, no duplicates', async () => {
    const db = await createTestDb();
    const { userId, workspaceId } = await seedWorkspace(db);
    const accountId = await insertAccount(db, workspaceId, userId, 'mock-email');
    const { service } = makeService(db);
    const dataset = createDemoDataset(new Date(DEMO_NOW));

    const run1 = await service.syncAccount(workspaceId, accountId, {
      mode: 'full',
      triggeredBy: 'connect',
    });

    // First incremental run resumes from the saved cursor and only sees the
    // demo dataset's "new arrivals".
    const run2 = await service.syncAccount(workspaceId, accountId, {
      mode: 'incremental',
      triggeredBy: 'manual',
    });
    expect(run2.cursorBefore).toBe(run1.cursorAfter);
    expect(run2.status).toBe('success');
    expect(run2.itemsSeen).toBe(dataset.incremental.email.length);
    expect(run2.itemsCreated).toBe(dataset.incremental.email.length);

    // Second incremental run finds nothing new.
    const run3 = await service.syncAccount(workspaceId, accountId, {
      mode: 'incremental',
      triggeredBy: 'manual',
    });
    expect(run3.status).toBe('success');
    expect(run3.itemsSeen).toBe(0);
    expect(run3.itemsCreated).toBe(0);

    const items = await db
      .selectFrom('sourceItems')
      .select(['externalId'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(items).toHaveLength(dataset.emails.length + dataset.incremental.email.length);
    expect(new Set(items.map((i) => i.externalId)).size).toBe(items.length);
  });

  it('cross-account dedupe skips items whose dedupeKey already exists in the workspace', async () => {
    const db = await createTestDb();
    const { userId, workspaceId } = await seedWorkspace(db);
    const accountA = await insertAccount(db, workspaceId, userId, 'mock-calendar', {
      category: 'calendar',
    });
    const accountB = await insertAccount(db, workspaceId, userId, 'mock-calendar', {
      category: 'calendar',
    });
    const { service } = makeService(db);
    const dataset = createDemoDataset(new Date(DEMO_NOW));
    // The demo calendar events all carry dedupeHints (ICS UIDs).
    expect(dataset.calendarEvents.every((e) => e.dedupeHint)).toBe(true);

    const runA = await service.syncAccount(workspaceId, accountA, {
      mode: 'full',
      triggeredBy: 'manual',
    });
    expect(runA.itemsCreated).toBe(dataset.calendarEvents.length);

    const runB = await service.syncAccount(workspaceId, accountB, {
      mode: 'full',
      triggeredBy: 'manual',
    });
    expect(runB.status).toBe('success');
    expect(runB.itemsSeen).toBe(dataset.calendarEvents.length);
    expect(runB.itemsCreated).toBe(0);
    expect(runB.log).toContain('dedupeKey');

    const items = await db
      .selectFrom('sourceItems')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(items).toHaveLength(dataset.calendarEvents.length);
  });

  it('throws 404 for a missing account', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const { service } = makeService(db);
    await expect(
      service.syncAccount(workspaceId, 'acc_missing', { mode: 'full', triggeredBy: 'manual' }),
    ).rejects.toSatisfy((err) => err instanceof HttpError && err.statusCode === 404);
  });

  it('syncDueAccounts syncs only due connected accounts and survives broken ones', async () => {
    const db = await createTestDb();
    const { userId, workspaceId } = await seedWorkspace(db);
    // Broken provider first: must not stop the rest.
    await insertAccount(db, workspaceId, userId, 'no-such-provider');
    const dueAccount = await insertAccount(db, workspaceId, userId, 'mock-email');
    // Recently synced: not due (default interval 15 minutes).
    const freshAccount = await insertAccount(db, workspaceId, userId, 'mock-chat', {
      category: 'chat',
      lastSyncAt: nowIso(),
    });
    const { service } = makeService(db);

    const synced = await service.syncDueAccounts({ triggeredBy: 'scheduled' });
    expect(synced).toBe(1);

    const due = await db
      .selectFrom('sourceAccounts')
      .select(['lastSyncAt', 'syncCursor'])
      .where('id', '=', dueAccount)
      .executeTakeFirstOrThrow();
    expect(due.syncCursor).toMatch(/^synced:\d+$/);

    const fresh = await db
      .selectFrom('sourceAccounts')
      .select(['syncCursor'])
      .where('id', '=', freshAccount)
      .executeTakeFirstOrThrow();
    expect(fresh.syncCursor).toBeNull();
  });
});
