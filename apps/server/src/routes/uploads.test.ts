import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultRegistry } from '@jarvis/connectors';
import type { Db } from '@jarvis/db';
import multipart from '@fastify/multipart';
import fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import type { AppContext, LlmRouterService, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createIndexingService } from '../services/indexing.js';
import { createStorageService } from '../services/storage.js';
import { createUploadsService } from '../services/uploads.js';
import { createSqlScanVectorStore } from '../services/vector-store.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerUploadsRoutes } from './uploads.js';

const BOUNDARY = 'X-JARVIS-TEST-BOUNDARY';

function multipartPayload(filename: string, contentType: string, body: string): string {
  return [
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    '',
    body,
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');
}

let dir: string;
let config: AppConfig;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jarvis-uploads-route-'));
  config = loadConfig({ JARVIS_DATA_DIR: dir, JARVIS_STORAGE_DRIVER: 'local' });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db = await createTestDb();
  const { userId, workspaceId } = await seedWorkspace(db);
  const audit = createAuditService({ db });
  const storage = createStorageService({ config });
  const nullEmbeddingRouter = {
    embeddingClient: async () => null,
  } as unknown as LlmRouterService;
  const indexing = createIndexingService({ db, llm: nullEmbeddingRouter, vectors: createSqlScanVectorStore({ db }) });
  const uploads = createUploadsService({ db, storage, indexing, audit });
  const ctx: AppContext = {
    config,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, storage, indexing, uploads } as Partial<Services> as Services,
  };

  app = fastify();
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
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
  registerUploadsRoutes(app, ctx);
});

describe('uploads routes', () => {
  it('uploads, lists, fetches, reads text, and deletes via multipart', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      payload: multipartPayload('hello.txt', 'text/plain', 'hello jarvis upload'),
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    });
    expect(created.statusCode).toBe(200);
    const file = created.json().file;
    expect(file.filename).toBe('hello.txt');
    expect(file.mimeType).toBe('text/plain');
    expect(file.status).toBe('ready');
    expect(file.textExtracted).toBe(1);
    expect(file.sourceItemId).not.toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/uploads' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].id).toBe(file.id);

    const got = await app.inject({ method: 'GET', url: `/api/uploads/${file.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().file.id).toBe(file.id);

    const text = await app.inject({ method: 'GET', url: `/api/uploads/${file.id}/text` });
    expect(text.statusCode).toBe(200);
    expect(text.json().text).toBe('hello jarvis upload');

    const del = await app.inject({ method: 'DELETE', url: `/api/uploads/${file.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const after = await app.inject({ method: 'GET', url: `/api/uploads/${file.id}` });
    expect(after.statusCode).toBe(404);
  });

  it('404s for unknown ids on get/text/delete', async () => {
    for (const [method, url] of [
      ['GET', '/api/uploads/upl_missing'],
      ['GET', '/api/uploads/upl_missing/text'],
      ['DELETE', '/api/uploads/upl_missing'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });
});
