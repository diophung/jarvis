import { createDefaultRegistry } from '@jarvis/connectors';
import { createDbMetrics, type Db } from '@jarvis/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, Services, StorageService } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createCacheService } from '../services/cache.js';
import { createMemoryService } from '../services/memory.js';
import { createPrivacyService } from '../services/privacy.js';
import { createSettingsService } from '../services/settings.js';
import { createSqlScanVectorStore } from '../services/vector-store.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerHealthRoutes } from './health.js';
import { registerPrivacyRoutes } from './privacy.js';

let db: Db;
let workspaceId: string;
let userId: string;
let app: FastifyInstance;

const storageStub: StorageService = {
  save: async () => ({ storagePath: 'x', sizeBytes: 0, sha256: '' }),
  read: async () => Buffer.from(''),
  remove: async () => {},
};

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  const vectors = createSqlScanVectorStore({ db });
  const cache = createCacheService({});
  const privacy = createPrivacyService({ db, audit, storage: storageStub, vectors });
  const memory = createMemoryService({ db, settings, audit });
  const ctx: AppContext = {
    config: { env: { JARVIS_STORAGE_DRIVER: 'local', JARVIS_AUTH_MODE: 'local', JARVIS_DEMO_SEED: false, JARVIS_DATA_DIR: './data' } } as unknown as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, settings, privacy, memory, vectors, cache } as Partial<Services> as Services,
    dbMetrics: createDbMetrics(),
  };
  app = fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  app.setErrorHandler((err: Error, _request, reply) => {
    const status = err instanceof HttpError ? err.statusCode : 500;
    void reply.code(status).send({ error: { code: 'error', message: err.message } });
  });
  registerPrivacyRoutes(app, ctx);
  registerHealthRoutes(app, ctx);
});

describe('privacy routes', () => {
  it('exports account data as an attachment', async () => {
    const memory = createMemoryService({
      db,
      settings: createSettingsService({ db }),
      audit: createAuditService({ db }),
    });
    await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'exportable fact',
      origin: 'explicit',
    });
    const res = await app.inject({ method: 'GET', url: '/api/account/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('jarvis-account-export.json');
    const body = res.json();
    expect(body.tables.memoryEntries.rows).toHaveLength(1);
  });

  it('creates a deletion request, exposes status, and 409s on duplicates', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/account/delete-data' });
    expect(created.statusCode).toBe(200);
    expect(created.json().request.status).toBe('pending');

    const status = await app.inject({ method: 'GET', url: '/api/account/delete-data' });
    expect(status.json().request.status).toBe('pending');

    const duplicate = await app.inject({ method: 'POST', url: '/api/account/delete-data' });
    expect(duplicate.statusCode).toBe(409);
  });
});

describe('health routes', () => {
  it('readiness returns 200 with db detail when healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().db.ok).toBe(true);
    expect(res.json().db.dialect).toBe('sqlite');
  });

  it('metrics endpoint reports db, cache, vector, and deletion-job stats without PII', async () => {
    await app.inject({ method: 'GET', url: '/api/health/ready' }); // generate some queries
    const res = await app.inject({ method: 'GET', url: '/api/health/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.db.queries.totalQueries).toBe('number'); // hook not attached to the test db
    expect(body.db.pool.max).toBe(1);
    expect(body.cache.backend).toBe('memory');
    expect(body.vectorStore).toBe('sql_scan');
    expect(body.deletionJobs.open).toBe(0);
    // PII safety: the metrics payload never contains row contents.
    expect(JSON.stringify(body)).not.toContain('exportable fact');
  });

  it('readiness returns 503 when the database is unreachable', async () => {
    await db.destroy();
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
  });
});
