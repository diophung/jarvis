import { newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PrivacyService, StorageService } from '../context.js';
import { createAuditService } from './audit.js';
import { createPrivacyService } from './privacy.js';
import { createSqlScanVectorStore } from './vector-store.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';

let db: Db;
let privacy: PrivacyService;
let removedPaths: string[];

function stubStorage(): StorageService {
  return {
    async save() {
      throw new Error('not used');
    },
    async read() {
      throw new Error('not used');
    },
    async remove(path: string) {
      removedPaths.push(path);
    },
  };
}

/** Seed a small slice of user data across several content tables. */
async function seedContent(workspaceId: string, userId: string): Promise<void> {
  const now = nowIso();
  const itemId = newId('itm');
  await db
    .insertInto('sourceItems')
    .values({
      id: itemId,
      workspaceId,
      accountId: 'acc_x',
      provider: 'gmail',
      category: 'email',
      externalId: itemId,
      dedupeKey: null,
      title: 'Budget review',
      bodyText: 'The budget needs review.',
      snippet: null,
      sender: null,
      participants: '[]',
      itemTimestamp: now,
      dueAt: null,
      startsAt: null,
      endsAt: null,
      url: null,
      threadExternalId: null,
      projectIds: '[]',
      peopleIds: '[]',
      labels: '[]',
      rawMetadata: '{}',
      provenance: '{}',
      isRead: 0,
      contentHash: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  const chunkId = newId('chk');
  await db
    .insertInto('retrievalChunks')
    .values({
      id: chunkId,
      workspaceId,
      sourceType: 'source_item',
      refId: itemId,
      chunkIndex: 0,
      text: 'The budget needs review.',
      metadata: '{}',
      createdAt: now,
    })
    .execute();
  await db
    .insertInto('embeddingRecords')
    .values({
      id: newId('emb'),
      workspaceId,
      chunkId,
      providerConfigId: null,
      model: 'mock',
      dims: 3,
      vector: toJson([1, 0, 0]),
      createdAt: now,
    })
    .execute();
  await db
    .insertInto('memoryEntries')
    .values({
      id: newId('mem'),
      workspaceId,
      userId,
      kind: 'preference',
      content: 'Prefers short replies',
      origin: 'explicit',
      confidence: 1,
      enabled: 1,
      relatedPeopleIds: '[]',
      relatedProjectIds: '[]',
      provenance: '{}',
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  await db
    .insertInto('uploadedFiles')
    .values({
      id: newId('upl'),
      workspaceId,
      userId,
      accountId: null,
      sourceItemId: null,
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      storagePath: `${workspaceId}/doc.pdf`,
      textExtracted: 1,
      extractionError: null,
      status: 'ready',
      sha256: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

beforeEach(async () => {
  db = await createTestDb();
  removedPaths = [];
  const audit = createAuditService({ db });
  privacy = createPrivacyService({
    db,
    audit,
    storage: stubStorage(),
    vectors: createSqlScanVectorStore({ db }),
  });
});

describe('account data export', () => {
  it('exports all content tables for the workspace and audits the export', async () => {
    const { workspaceId, userId } = await seedWorkspace(db);
    await seedContent(workspaceId, userId);
    const data = await privacy.exportAccountData(workspaceId, userId);
    expect(data.tables['sourceItems']?.rows).toHaveLength(1);
    expect(data.tables['memoryEntries']?.rows).toHaveLength(1);
    expect(data.tables['embeddingRecords']?.rows).toHaveLength(1);
    expect(data.tables['auditLogs']).toBeDefined();
    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'privacy.export')
      .execute();
    expect(audits).toHaveLength(1);
  });

  it('export is tenant-isolated: only the requesting workspace is included', async () => {
    const a = await seedWorkspace(db);
    const b = await seedWorkspace(db);
    await seedContent(a.workspaceId, a.userId);
    await seedContent(b.workspaceId, b.userId);
    const data = await privacy.exportAccountData(a.workspaceId, a.userId);
    const rows = data.tables['sourceItems']?.rows as Array<{ workspaceId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(a.workspaceId);
  });
});

describe('data deletion', () => {
  it('end to end: request -> worker purge -> data gone, blobs removed, audited', async () => {
    const { workspaceId, userId } = await seedWorkspace(db);
    await seedContent(workspaceId, userId);

    const request = await privacy.requestDeletion(workspaceId, userId);
    expect(request.status).toBe('pending');

    const { processed } = await privacy.processPending();
    expect(processed).toBe(1);

    const status = await privacy.getDeletionStatus(workspaceId);
    expect(status?.status).toBe('completed');
    expect(status?.tablesPurged['sourceItems']).toBe(1);
    expect(status?.tablesPurged['memoryEntries']).toBe(1);

    for (const table of ['sourceItems', 'retrievalChunks', 'embeddingRecords', 'memoryEntries', 'uploadedFiles'] as const) {
      const rows = await db.selectFrom(table).selectAll().where('workspaceId', '=', workspaceId).execute();
      expect(rows).toEqual([]);
    }
    expect(removedPaths).toEqual([`${workspaceId}/doc.pdf`]);

    // Audit trail survives the purge (the legal record).
    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(audits.some((a) => a.eventType === 'privacy.deletion.completed')).toBe(true);
    // Identity rows survive too.
    const user = await db.selectFrom('users').selectAll().where('id', '=', userId).execute();
    expect(user).toHaveLength(1);
  });

  it('purging workspace A never touches workspace B (tenant isolation)', async () => {
    const a = await seedWorkspace(db);
    const b = await seedWorkspace(db);
    await seedContent(a.workspaceId, a.userId);
    await seedContent(b.workspaceId, b.userId);

    await privacy.requestDeletion(a.workspaceId, a.userId);
    await privacy.processPending();

    const aItems = await db.selectFrom('sourceItems').selectAll().where('workspaceId', '=', a.workspaceId).execute();
    const bItems = await db.selectFrom('sourceItems').selectAll().where('workspaceId', '=', b.workspaceId).execute();
    expect(aItems).toEqual([]);
    expect(bItems).toHaveLength(1);
    const bMemory = await db.selectFrom('memoryEntries').selectAll().where('workspaceId', '=', b.workspaceId).execute();
    expect(bMemory).toHaveLength(1);
  });

  it('rejects a second request while one is in flight', async () => {
    const { workspaceId, userId } = await seedWorkspace(db);
    await privacy.requestDeletion(workspaceId, userId);
    await expect(privacy.requestDeletion(workspaceId, userId)).rejects.toThrow(/already in progress/);
  });

  it('a completed run allows a new request (re-runnable)', async () => {
    const { workspaceId, userId } = await seedWorkspace(db);
    await privacy.requestDeletion(workspaceId, userId);
    await privacy.processPending();
    const again = await privacy.requestDeletion(workspaceId, userId);
    expect(again.status).toBe('pending');
  });
});
