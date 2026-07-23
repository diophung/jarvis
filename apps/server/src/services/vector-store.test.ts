import { newId, nowIso } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VectorStore } from '../context.js';
import { createSqlScanVectorStore, createVectorStore } from './vector-store.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';

let db: Db;
let workspaceId: string;
let store: VectorStore;

async function seedChunk(text: string, sourceType = 'source_item'): Promise<string> {
  const id = newId('chk');
  await db
    .insertInto('retrievalChunks')
    .values({
      id,
      workspaceId,
      sourceType,
      refId: newId('itm'),
      chunkIndex: 0,
      text,
      metadata: '{}',
      createdAt: nowIso(),
    })
    .execute();
  return id;
}

beforeEach(async () => {
  db = await createTestDb();
  workspaceId = (await seedWorkspace(db)).workspaceId;
  store = createSqlScanVectorStore({ db });
});

describe('SQL-scan vector store', () => {
  it('upserts vectors and ranks search hits by cosine similarity', async () => {
    const close = await seedChunk('about budgets');
    const far = await seedChunk('about kittens');
    await store.upsert(workspaceId, [
      { chunkId: close, providerConfigId: null, model: 'm1', vector: [1, 0, 0] },
      { chunkId: far, providerConfigId: null, model: 'm1', vector: [0, 1, 0] },
    ]);

    const hits = await store.search(workspaceId, 'm1', [0.9, 0.1, 0]);
    expect(hits[0]?.chunkId).toBe(close);
    expect(hits[0]?.cosine).toBeGreaterThan(hits[1]?.cosine ?? 1);
    expect(hits[0]?.text).toBe('about budgets');
  });

  it('only compares vectors from the requested model', async () => {
    const chunk = await seedChunk('model scoped');
    await store.upsert(workspaceId, [
      { chunkId: chunk, providerConfigId: null, model: 'm1', vector: [1, 0] },
    ]);
    expect(await store.search(workspaceId, 'm2', [1, 0])).toEqual([]);
  });

  it('filters by sourceTypes and applies minCosine', async () => {
    const memoryChunk = await seedChunk('memory text', 'memory');
    const itemChunk = await seedChunk('item text', 'source_item');
    await store.upsert(workspaceId, [
      { chunkId: memoryChunk, providerConfigId: null, model: 'm', vector: [1, 0] },
      { chunkId: itemChunk, providerConfigId: null, model: 'm', vector: [0.7, 0.7] },
    ]);
    const onlyItems = await store.search(workspaceId, 'm', [1, 0], { sourceTypes: ['source_item'] });
    expect(onlyItems.map((h) => h.chunkId)).toEqual([itemChunk]);
    const strict = await store.search(workspaceId, 'm', [1, 0], { minCosine: 0.95 });
    expect(strict.map((h) => h.chunkId)).toEqual([memoryChunk]);
  });

  it('removeByChunkIds deletes vectors', async () => {
    const chunk = await seedChunk('to be removed');
    await store.upsert(workspaceId, [
      { chunkId: chunk, providerConfigId: null, model: 'm', vector: [1, 0] },
    ]);
    await store.removeByChunkIds([chunk]);
    expect(await store.search(workspaceId, 'm', [1, 0])).toEqual([]);
    const rows = await db.selectFrom('embeddingRecords').selectAll().execute();
    expect(rows).toEqual([]);
  });
});

describe('createVectorStore factory', () => {
  it('selects the SQL scan adapter on SQLite', async () => {
    const selected = await createVectorStore({ db });
    expect(selected.kind).toBe('sql_scan');
  });
});
