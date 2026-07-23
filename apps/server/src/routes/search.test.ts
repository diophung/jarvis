import { createDefaultRegistry } from '@jarvis/connectors';
import type { Db } from '@jarvis/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, IndexingService, LlmRouterService, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createIndexingService } from '../services/indexing.js';
import { createRetrievalService } from '../services/retrieval.js';
import { createSqlScanVectorStore } from '../services/vector-store.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerSearchRoutes } from './search.js';

let db: Db;
let workspaceId: string;
let indexing: IndexingService;
let app: FastifyInstance;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  const nullEmbeddingRouter = {
    embeddingClient: async () => null,
  } as unknown as LlmRouterService;
  indexing = createIndexingService({ db, llm: nullEmbeddingRouter, vectors: createSqlScanVectorStore({ db }) });
  const retrieval = createRetrievalService({ db, llm: nullEmbeddingRouter, vectors: createSqlScanVectorStore({ db }) });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { indexing, retrieval } as Partial<Services> as Services,
  };

  app = fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = seeded.userId;
    request.workspaceId = workspaceId;
  });
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) {
      void reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal error';
    void reply.code(500).send({ error: { code: 'error', message } });
  });
  registerSearchRoutes(app, ctx);
});

describe('search route', () => {
  it('400s when q is missing or blank', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/search' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('bad_request');

    const blank = await app.inject({ method: 'GET', url: '/api/search?q=%20%20' });
    expect(blank.statusCode).toBe(400);
  });

  it('returns keyword results in the contract shape', async () => {
    await indexing.indexText(workspaceId, 'source_item', 'itm_1', 'budget review on Thursday', {
      title: 'Budget thread',
      sourceLabel: 'Email',
      category: 'email',
    });
    await indexing.indexText(workspaceId, 'uploaded_file', 'upl_1', 'budget spreadsheet upload', {
      title: 'budget.txt',
      sourceLabel: 'Uploaded file',
      category: 'upload',
    });

    const res = await app.inject({ method: 'GET', url: '/api/search?q=budget' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('keyword');
    expect(body.results).toHaveLength(2);
    for (const result of body.results) {
      expect(result.matchType).toBe('keyword');
      expect(result.snippet).toContain('budget');
      expect(typeof result.chunkId).toBe('string');
      expect(typeof result.score).toBe('number');
    }
  });

  it('filters by the types CSV and ignores unknown type values', async () => {
    await indexing.indexText(workspaceId, 'source_item', 'itm_1', 'budget email thread', {
      title: 'Budget thread',
    });
    await indexing.indexText(workspaceId, 'uploaded_file', 'upl_1', 'budget file body', {
      title: 'budget.txt',
    });

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/search?q=budget&types=uploaded_file',
    });
    expect(filtered.json().results).toHaveLength(1);
    expect(filtered.json().results[0].sourceType).toBe('uploaded_file');

    const mixed = await app.inject({
      method: 'GET',
      url: '/api/search?q=budget&types=uploaded_file,bogus',
    });
    expect(mixed.json().results).toHaveLength(1);

    // All-invalid types degrade to no filter.
    const bogus = await app.inject({ method: 'GET', url: '/api/search?q=budget&types=bogus' });
    expect(bogus.json().results).toHaveLength(2);
  });

  it('applies the limit query parameter', async () => {
    for (let i = 0; i < 4; i += 1) {
      await indexing.indexText(workspaceId, 'source_item', `itm_${i}`, `budget item ${i}`, {});
    }
    const res = await app.inject({ method: 'GET', url: '/api/search?q=budget&limit=2' });
    expect(res.json().results).toHaveLength(2);
  });
});
