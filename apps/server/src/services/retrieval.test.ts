import { newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import { LlmClient, createMockAdapter } from '@donna/llm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LlmRouterService, RoutedLlm } from '../context.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { cosineSimilarity, createRetrievalService, makeSnippet, tokenize } from './retrieval.js';

function nullEmbeddingRouter(): LlmRouterService {
  return { embeddingClient: async () => null } as unknown as LlmRouterService;
}

function mockEmbeddingRouter(): { router: LlmRouterService; routed: RoutedLlm } {
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
  return { router: { embeddingClient: async () => routed } as unknown as LlmRouterService, routed };
}

async function seedChunk(
  db: Db,
  workspaceId: string,
  opts: {
    sourceType?: string;
    refId: string;
    text: string;
    title?: string;
    chunkIndex?: number;
    createdAt?: string;
  },
): Promise<string> {
  const id = newId('chk');
  await db
    .insertInto('retrievalChunks')
    .values({
      id,
      workspaceId,
      sourceType: opts.sourceType ?? 'source_item',
      refId: opts.refId,
      chunkIndex: opts.chunkIndex ?? 0,
      text: opts.text,
      metadata: toJson({ title: opts.title ?? 'Untitled', sourceLabel: 'Test' }),
      createdAt: opts.createdAt ?? nowIso(),
    })
    .execute();
  return id;
}

describe('tokenize', () => {
  it('lowercases, drops short tokens, dedupes, and caps at 8', () => {
    expect(tokenize('The Budget BUDGET to be or a an review')).toEqual(['the', 'budget', 'review']);
    const many = tokenize('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    expect(many).toHaveLength(8);
  });
});

describe('makeSnippet', () => {
  it('centers ~200 chars on the first matched token', () => {
    const text = `${'x'.repeat(300)} zebra crossing ${'y'.repeat(300)}`;
    const snippet = makeSnippet(text, ['zebra']);
    expect(snippet).toContain('zebra');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(202);
  });

  it('falls back to the start of the text when no token matches', () => {
    expect(makeSnippet('plain text here', ['missing'])).toBe('plain text here');
  });
});

describe('cosineSimilarity', () => {
  it('handles identical, orthogonal, and mismatched vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('retrieval service (keyword leg)', () => {
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedWorkspace(db);
    workspaceId = seeded.workspaceId;
  });

  it('finds seeded chunks with mode keyword and correct snippet/matchType', async () => {
    await seedChunk(db, workspaceId, {
      refId: 'itm_budget',
      text: 'The quarterly budget review happens on Thursday with finance.',
      title: 'Budget review',
    });
    await seedChunk(db, workspaceId, {
      refId: 'itm_offsite',
      text: 'Team offsite planning is unrelated to money topics.',
      title: 'Offsite',
    });

    const retrieval = createRetrievalService({ db, llm: nullEmbeddingRouter() });
    const { results, mode } = await retrieval.search(workspaceId, 'budget review');

    expect(mode).toBe('keyword');
    expect(results.length).toBe(1);
    const hit = results[0];
    expect(hit?.refId).toBe('itm_budget');
    expect(hit?.sourceType).toBe('source_item');
    expect(hit?.matchType).toBe('keyword');
    expect(hit?.title).toBe('Budget review');
    expect(hit?.sourceLabel).toBe('Test');
    expect(hit?.snippet).toContain('budget review');
    expect(hit?.score).toBeGreaterThan(0);
  });

  it('ranks more matched tokens + title bonus above single-token matches', async () => {
    await seedChunk(db, workspaceId, {
      refId: 'itm_strong',
      text: 'Budget review for the marketing campaign spend.',
      title: 'Budget review',
    });
    await seedChunk(db, workspaceId, {
      refId: 'itm_weak',
      text: 'A passing mention of the budget only.',
      title: 'Other note',
    });

    const retrieval = createRetrievalService({ db, llm: nullEmbeddingRouter() });
    const { results } = await retrieval.search(workspaceId, 'budget review');
    expect(results.map((r) => r.refId)).toEqual(['itm_strong', 'itm_weak']);
    const strong = results[0];
    const weak = results[1];
    expect(strong !== undefined && weak !== undefined && strong.score > weak.score).toBe(true);
  });

  it('applies the sourceTypes filter and dedupes to the best chunk per refId', async () => {
    await seedChunk(db, workspaceId, {
      sourceType: 'uploaded_file',
      refId: 'upl_1',
      chunkIndex: 0,
      text: 'budget figures part one',
      title: 'plan.txt',
    });
    await seedChunk(db, workspaceId, {
      sourceType: 'uploaded_file',
      refId: 'upl_1',
      chunkIndex: 1,
      text: 'budget figures part two',
      title: 'plan.txt',
    });
    await seedChunk(db, workspaceId, {
      sourceType: 'source_item',
      refId: 'itm_1',
      text: 'budget thread in email',
      title: 'Budget thread',
    });

    const retrieval = createRetrievalService({ db, llm: nullEmbeddingRouter() });
    const all = await retrieval.search(workspaceId, 'budget');
    // Two referenced entities, each deduped to one best chunk.
    expect(all.results).toHaveLength(2);

    const filtered = await retrieval.search(workspaceId, 'budget', {
      sourceTypes: ['uploaded_file'],
    });
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.refId).toBe('upl_1');
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedChunk(db, workspaceId, {
        refId: `itm_${i}`,
        text: `budget item number ${i}`,
        title: `Item ${i}`,
      });
    }
    const retrieval = createRetrievalService({ db, llm: nullEmbeddingRouter() });
    const { results } = await retrieval.search(workspaceId, 'budget', { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('does not leak chunks from other workspaces', async () => {
    const other = await seedWorkspace(db);
    await seedChunk(db, other.workspaceId, {
      refId: 'itm_other',
      text: 'budget belonging to another workspace',
    });
    const retrieval = createRetrievalService({ db, llm: nullEmbeddingRouter() });
    const { results } = await retrieval.search(workspaceId, 'budget');
    expect(results).toHaveLength(0);
  });
});

describe('retrieval service (semantic leg)', () => {
  it('merges semantic and keyword candidates with matchType both/semantic', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const { router, routed } = mockEmbeddingRouter();

    const query = 'quarterly budget review meeting';
    // Chunk A: text identical to the query -> cosine 1 AND keyword match -> 'both'.
    const chunkA = await seedChunk(db, workspaceId, {
      refId: 'itm_a',
      text: query,
      title: 'Exact match',
    });
    // Chunk B: no shared keywords; store the query's own vector -> pure 'semantic'.
    const chunkB = await seedChunk(db, workspaceId, {
      refId: 'itm_b',
      text: 'zzz qqq unrelated words entirely',
      title: 'Vector twin',
    });
    const embedded = await routed.client.embed({ model: routed.model, input: [query] });
    const queryVector = embedded.vectors[0];
    expect(queryVector).toBeDefined();
    for (const chunkId of [chunkA, chunkB]) {
      await db
        .insertInto('embeddingRecords')
        .values({
          id: newId('emb'),
          workspaceId,
          chunkId,
          providerConfigId: null,
          model: 'mock-embedding',
          dims: queryVector?.length ?? 0,
          vector: toJson(queryVector ?? []),
          createdAt: nowIso(),
        })
        .execute();
    }

    const retrieval = createRetrievalService({ db, llm: router });
    const { results, mode } = await retrieval.search(workspaceId, query);

    expect(mode).toBe('semantic+keyword');
    const byRef = new Map(results.map((r) => [r.refId, r]));
    expect(byRef.get('itm_a')?.matchType).toBe('both');
    expect(byRef.get('itm_b')?.matchType).toBe('semantic');
    // 'both' (keyword 1.0 normalized + cosine 1.0) outranks pure semantic.
    expect(results[0]?.refId).toBe('itm_a');
  });

  it('excludes embedding records stored under a different model', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const { router, routed } = mockEmbeddingRouter();

    const query = 'quarterly budget review meeting';
    // Neither chunk shares keywords with the query: hits are semantic-only.
    const chunkLegacy = await seedChunk(db, workspaceId, {
      refId: 'itm_legacy',
      text: 'zzz qqq stale provider words',
      title: 'Legacy vectors',
    });
    const chunkCurrent = await seedChunk(db, workspaceId, {
      refId: 'itm_current',
      text: 'xxx yyy fresh provider words',
      title: 'Current vectors',
    });
    const embedded = await routed.client.embed({ model: routed.model, input: [query] });
    const queryVector = embedded.vectors[0];
    expect(queryVector).toBeDefined();
    // Both records carry the query's own vector (cosine 1), but only the one
    // stored under the routed model ('mock-embedding') may be considered.
    for (const [chunkId, model] of [
      [chunkLegacy, 'legacy-embedding'],
      [chunkCurrent, 'mock-embedding'],
    ] as const) {
      await db
        .insertInto('embeddingRecords')
        .values({
          id: newId('emb'),
          workspaceId,
          chunkId,
          providerConfigId: null,
          model,
          dims: queryVector?.length ?? 0,
          vector: toJson(queryVector ?? []),
          createdAt: nowIso(),
        })
        .execute();
    }

    const retrieval = createRetrievalService({ db, llm: router });
    const { results, mode } = await retrieval.search(workspaceId, query);
    expect(mode).toBe('semantic+keyword');
    expect(results.map((r) => r.refId)).toEqual(['itm_current']);
  });

  it('falls back to keyword mode when the embed call fails', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await seedChunk(db, workspaceId, { refId: 'itm_1', text: 'budget review notes' });

    const routed = {
      client: {
        embed: async () => {
          throw new Error('embedding backend exploded');
        },
      },
      model: 'broken',
    } as unknown as RoutedLlm;
    const router = { embeddingClient: async () => routed } as unknown as LlmRouterService;

    const retrieval = createRetrievalService({ db, llm: router });
    const { results, mode } = await retrieval.search(workspaceId, 'budget');
    expect(mode).toBe('keyword');
    expect(results).toHaveLength(1);
    expect(results[0]?.matchType).toBe('keyword');
  });
});
