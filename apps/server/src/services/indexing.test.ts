import { LlmClient, MOCK_EMBEDDING_DIMS, createMockAdapter } from '@donna/llm';
import { describe, expect, it } from 'vitest';
import type { LlmRouterService, RoutedLlm } from '../context.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createIndexingService } from './indexing.js';

const TEXT = [
  'Quarterly planning kicks off next week with the budget review.',
  'Marketing wants a 12 percent increase for the spring campaign.',
  'Engineering is focused on the retrieval layer and embedding support.',
].join('\n\n');

function nullEmbeddingRouter(): LlmRouterService {
  return { embeddingClient: async () => null } as unknown as LlmRouterService;
}

function mockEmbeddingRouter(): LlmRouterService {
  const routed: RoutedLlm = {
    client: new LlmClient(createMockAdapter()),
    model: 'mock-embedding',
    params: {},
    providerConfigId: null,
    providerName: 'Mock',
    kind: 'mock',
    isLocal: true,
    isMock: true,
  };
  return { embeddingClient: async () => routed } as unknown as LlmRouterService;
}

function failingEmbeddingRouter(): LlmRouterService {
  const routed = {
    client: {
      embed: async () => {
        throw new Error('embedding backend exploded');
      },
    },
    model: 'broken-embedding',
    params: {},
    providerConfigId: null,
    providerName: 'Broken',
    kind: 'openai_compatible',
    isLocal: false,
    isMock: false,
  } as unknown as RoutedLlm;
  return { embeddingClient: async () => routed } as unknown as LlmRouterService;
}

describe('indexing service', () => {
  it('chunks text into retrieval_chunks with metadata (no embedding provider)', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const indexing = createIndexingService({ db, llm: nullEmbeddingRouter() });

    const result = await indexing.indexText(workspaceId, 'uploaded_file', 'upl_1', TEXT, {
      title: 'plan.txt',
      sourceLabel: 'Uploaded file',
      category: 'upload',
    });
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.embedded).toBe(false);

    const rows = await db
      .selectFrom('retrievalChunks')
      .selectAll()
      .where('sourceType', '=', 'uploaded_file')
      .where('refId', '=', 'upl_1')
      .execute();
    expect(rows).toHaveLength(result.chunks);
    expect(rows[0]?.workspaceId).toBe(workspaceId);
    expect(rows[0]?.metadata).toContain('plan.txt');
    expect(rows.map((r) => r.chunkIndex)).toContain(0);
  });

  it('replaces existing chunks on re-index', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const indexing = createIndexingService({ db, llm: nullEmbeddingRouter() });

    await indexing.indexText(workspaceId, 'source_item', 'itm_1', 'first version text', {});
    const before = await db
      .selectFrom('retrievalChunks')
      .select('id')
      .where('refId', '=', 'itm_1')
      .execute();
    expect(before.length).toBeGreaterThan(0);

    await indexing.indexText(workspaceId, 'source_item', 'itm_1', 'second version, different text', {});
    const after = await db
      .selectFrom('retrievalChunks')
      .selectAll()
      .where('refId', '=', 'itm_1')
      .execute();
    expect(after.length).toBeGreaterThan(0);
    const beforeIds = new Set(before.map((r) => r.id));
    expect(after.every((r) => !beforeIds.has(r.id))).toBe(true);
    expect(after.every((r) => r.text.includes('second version'))).toBe(true);
  });

  it('skips empty text (0 chunks) and clears any previous index', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const indexing = createIndexingService({ db, llm: nullEmbeddingRouter() });

    await indexing.indexText(workspaceId, 'memory', 'mem_1', 'remember this fact', {});
    const result = await indexing.indexText(workspaceId, 'memory', 'mem_1', '   \n  ', {});
    expect(result).toEqual({ chunks: 0, embedded: false });
    const rows = await db
      .selectFrom('retrievalChunks')
      .select('id')
      .where('refId', '=', 'mem_1')
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('embeds all chunks when an embedding provider is configured', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const indexing = createIndexingService({ db, llm: mockEmbeddingRouter() });

    const result = await indexing.indexText(workspaceId, 'uploaded_file', 'upl_2', TEXT, {
      title: 'plan.txt',
    });
    expect(result.embedded).toBe(true);

    const chunks = await db
      .selectFrom('retrievalChunks')
      .select('id')
      .where('refId', '=', 'upl_2')
      .execute();
    const embeddings = await db
      .selectFrom('embeddingRecords')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(embeddings).toHaveLength(chunks.length);
    expect(embeddings[0]?.model).toBe('mock-embedding');
    expect(embeddings[0]?.dims).toBe(MOCK_EMBEDDING_DIMS);
    const vector = JSON.parse(embeddings[0]?.vector ?? '[]') as number[];
    expect(vector).toHaveLength(MOCK_EMBEDDING_DIMS);
  });

  it('keeps chunks and reports embedded:false when embedding fails', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const indexing = createIndexingService({ db, llm: failingEmbeddingRouter() });

    const result = await indexing.indexText(workspaceId, 'digest', 'dig_1', TEXT, {});
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.embedded).toBe(false);

    const chunks = await db
      .selectFrom('retrievalChunks')
      .select('id')
      .where('refId', '=', 'dig_1')
      .execute();
    expect(chunks).toHaveLength(result.chunks);
    const embeddings = await db.selectFrom('embeddingRecords').select('id').execute();
    expect(embeddings).toHaveLength(0);
  });

  it('removeIndex deletes chunks and their embeddings', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const indexing = createIndexingService({ db, llm: mockEmbeddingRouter() });

    await indexing.indexText(workspaceId, 'uploaded_file', 'upl_3', TEXT, {});
    await indexing.removeIndex('uploaded_file', 'upl_3');

    const chunks = await db
      .selectFrom('retrievalChunks')
      .select('id')
      .where('refId', '=', 'upl_3')
      .execute();
    const embeddings = await db.selectFrom('embeddingRecords').select('id').execute();
    expect(chunks).toHaveLength(0);
    expect(embeddings).toHaveLength(0);
  });
});
