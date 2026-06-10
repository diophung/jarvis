import { createDefaultRegistry } from '@donna/connectors';
import { newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import { createMockAdapter, LlmClient } from '@donna/llm';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, LlmRouterService, RoutedLlm, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createDigestService } from '../services/digest.js';
import { createScoringService } from '../services/scoring.js';
import { createSettingsService } from '../services/settings.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerDigestRoutes } from './digests.js';

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

let db: Db;
let workspaceId: string;
let userId: string;
let app: FastifyInstance;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;

  const llm = stubLlm();
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  const scoring = createScoringService({ db, llm, audit });
  const digest = createDigestService({ db, llm, scoring, audit, settings });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, settings, scoring, digest } as Partial<Services> as Services,
  };

  app = fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  app.setErrorHandler((err, _request, reply) => {
    const status = err instanceof HttpError ? err.statusCode : 500;
    const code = err instanceof HttpError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    void reply.code(status).send({ error: { code, message } });
  });
  registerDigestRoutes(app, ctx);
});

async function seedSourceItem(): Promise<void> {
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
      title: 'URGENT: contract sign-off needed',
      bodyText: 'This is urgent. Please approve the contract today.',
      snippet: 'This is urgent.',
      sender: toJson({ email: 'jin@meridianlabs.example' }),
      participants: toJson([]),
      itemTimestamp: now,
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
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
}

describe('digest routes', () => {
  it('latest returns null before any digest exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/digests/latest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ digest: null });
  });

  it('generates synchronously, then serves latest, list, and get', async () => {
    await seedSourceItem();

    const gen = await app.inject({ method: 'POST', url: '/api/digests/generate', payload: {} });
    expect(gen.statusCode).toBe(200);
    const digest = gen.json().digest;
    expect(digest.kind).toBe('manual'); // default kind
    expect(digest.status).toBe('ready');
    expect(Array.isArray(digest.items)).toBe(true);
    expect(digest.items.length).toBeGreaterThan(0);
    expect(Array.isArray(digest.items[0].signals)).toBe(true);
    expect(typeof digest.stats).toBe('object');

    const latest = await app.inject({ method: 'GET', url: '/api/digests/latest' });
    expect(latest.json().digest.id).toBe(digest.id);
    expect(latest.json().digest.items.length).toBe(digest.items.length);

    const list = await app.inject({ method: 'GET', url: '/api/digests' });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].id).toBe(digest.id);

    const byId = await app.inject({ method: 'GET', url: `/api/digests/${digest.id}` });
    expect(byId.json().digest.id).toBe(digest.id);

    const missing = await app.inject({ method: 'GET', url: '/api/digests/dig_missing' });
    expect(missing.statusCode).toBe(404);
  });

  it('regenerate passes supersedesDigestId through', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/digests/generate', payload: {} });
    const firstId = first.json().digest.id;
    const second = await app.inject({
      method: 'POST',
      url: '/api/digests/generate',
      payload: { kind: 'manual', supersedesDigestId: firstId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().digest.supersedesDigestId).toBe(firstId);
  });

  it('round-trips the schedule with cron validation and audit', async () => {
    const defaults = await app.inject({ method: 'GET', url: '/api/digests/schedule' });
    expect(defaults.json().schedule).toEqual({ cron: '0 8 * * *', enabled: false });

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/digests/schedule',
      payload: { cron: '0 8 * *', enabled: true },
    });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/digests/schedule',
      payload: { cron: '30 7 * * 1-5', enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().schedule).toEqual({ cron: '30 7 * * 1-5', enabled: true });

    const get = await app.inject({ method: 'GET', url: '/api/digests/schedule' });
    expect(get.json().schedule).toEqual({ cron: '30 7 * * 1-5', enabled: true });

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'settings.updated')
      .execute();
    expect(audits).toHaveLength(1);
  });
});
