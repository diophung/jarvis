import { createDefaultRegistry } from '@donna/connectors';
import { newId, nowIso, toJson } from '@donna/core';
import type { Db, SourceItemsTable } from '@donna/db';
import { createMockAdapter, LlmClient } from '@donna/llm';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, LlmRouterService, RoutedLlm, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createFeedbackService } from '../services/feedback.js';
import { createScoringService } from '../services/scoring.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerTaskRoutes } from './tasks.js';

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

  const audit = createAuditService({ db });
  const scoring = createScoringService({ db, llm: stubLlm(), audit });
  const feedback = createFeedbackService({ db, audit });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, scoring, feedback } as Partial<Services> as Services,
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
  registerTaskRoutes(app, ctx);
});

async function seedSourceItem(overrides: Partial<SourceItemsTable> = {}): Promise<string> {
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
      title: 'Review the launch plan',
      bodyText: 'Please review the plan.',
      snippet: 'Please review the plan.',
      sender: toJson({ email: 'jin@meridianlabs.example' }),
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
      ...overrides,
    })
    .execute();
  return id;
}

describe('task routes', () => {
  it('rescore creates candidates; GET lists them sorted with parsed signals', async () => {
    await seedSourceItem({ title: 'Routine FYI note', bodyText: 'fyi' });
    await seedSourceItem({
      title: 'URGENT: blocker needs sign-off',
      bodyText: 'We are blocked on you. This is critical and urgent.',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const rescore = await app.inject({ method: 'POST', url: '/api/tasks/rescore' });
    expect(rescore.statusCode).toBe(200);
    expect(rescore.json()).toEqual({ scored: 2 });

    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(2);
    // Ordered by overallScore desc.
    expect(items[0].overallScore).toBeGreaterThanOrEqual(items[1].overallScore);
    expect(items[0].title).toBe('URGENT: blocker needs sign-off');
    expect(items[0].status).toBe('open');
    expect(Array.isArray(items[0].signals)).toBe(true);
    expect(items[0].signals.length).toBeGreaterThan(0);
    expect(Array.isArray(items[0].peopleIds)).toBe(true);

    // Category + status filters.
    const byCategory = await app.inject({
      method: 'GET',
      url: `/api/tasks?category=${items[0].planningCategory}`,
    });
    expect(
      byCategory.json().items.every((t: { planningCategory: string }) => t.planningCategory === items[0].planningCategory),
    ).toBe(true);
    expect(byCategory.json().items.length).toBeGreaterThanOrEqual(1);

    const done = await app.inject({ method: 'GET', url: '/api/tasks?status=done' });
    expect(done.json().items).toHaveLength(0);

    const badStatus = await app.inject({ method: 'GET', url: '/api/tasks?status=bogus' });
    expect(badStatus.statusCode).toBe(400);
  });

  it('PATCH updates status and deferredUntil with validation', async () => {
    await seedSourceItem();
    await app.inject({ method: 'POST', url: '/api/tasks/rescore' });
    const items = (await app.inject({ method: 'GET', url: '/api/tasks' })).json().items;
    const taskId = items[0].id;

    const deferredUntil = new Date(Date.now() + 86_400_000).toISOString();
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'deferred', deferredUntil },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.status).toBe('deferred');
    expect(patch.json().task.deferredUntil).toBe(deferredUntil);

    // No longer in the default (open) list.
    const open = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(open.json().items).toHaveLength(0);

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'snoozed' },
    });
    expect(invalid.statusCode).toBe(400);

    const badDate = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { deferredUntil: 'not-a-date' },
    });
    expect(badDate.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/tsk_missing',
      payload: { status: 'done' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /api/feedback records feedback and applies task effects', async () => {
    await seedSourceItem();
    await app.inject({ method: 'POST', url: '/api/tasks/rescore' });
    const items = (await app.inject({ method: 'GET', url: '/api/tasks' })).json().items;
    const taskId = items[0].id;

    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { kind: 'deferred', taskCandidateId: taskId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const task = await db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow();
    expect(task.status).toBe('deferred');
    expect(task.deferredUntil).not.toBeNull();

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'feedback.recorded')
      .execute();
    expect(audits).toHaveLength(1);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { kind: 'amazing' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
