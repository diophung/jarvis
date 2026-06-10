import type { Db } from '@donna/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { maskSecret } from '../lib/crypto.js';
import { createAuditService } from '../services/audit.js';
import { createLlmRouterService } from '../services/llm-router.js';
import { createSecretsService } from '../services/secrets.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerLlmRoutes } from './llm.js';

const APP_SECRET = 'route-test-secret';

interface TestHarness {
  app: FastifyInstance;
  db: Db;
  ctx: AppContext;
  workspaceId: string;
  userId: string;
}

async function buildHarness(): Promise<TestHarness> {
  const db = await createTestDb();
  const { userId, workspaceId } = await seedWorkspace(db);
  const secrets = createSecretsService({ appSecret: APP_SECRET });
  const audit = createAuditService({ db });
  const llm = createLlmRouterService({ db, secrets, audit });

  const services = { secrets, audit, llm } as Partial<Services> as Services;
  const ctx = { db, services } as Partial<AppContext> as AppContext;

  const app = Fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  app.setErrorHandler((err: Error, _request, reply) => {
    if (err instanceof HttpError) {
      void reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message } });
      return;
    }
    void reply.code(500).send({ error: { code: 'internal', message: err.message } });
  });
  registerLlmRoutes(app, ctx);
  await app.ready();
  return { app, db, ctx, workspaceId, userId };
}

describe('llm routes', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    await h.db.destroy();
    delete process.env.DONNA_ROUTE_TEST_KEY;
  });

  async function createProvider(
    body: Record<string, unknown> = {},
  ): Promise<Record<string, any>> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/llm/providers',
      payload: {
        name: 'My Provider',
        kind: 'openai',
        model: 'gpt-test',
        ...body,
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { provider: Record<string, any> }).provider;
  }

  it('creates a provider, encrypting and never returning the api key', async () => {
    const provider = await createProvider({ apiKey: 'sk-superduper-secret-key' });
    expect(provider.hasStoredKey).toBe(true);
    expect(provider.apiKeyMasked).toBe(maskSecret('sk-superduper-secret-key'));
    expect(provider).not.toHaveProperty('apiKeyEncrypted');

    const list = await h.app.inject({ method: 'GET', url: '/api/llm/providers' });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('apiKeyEncrypted');
    expect(list.body).not.toContain('sk-superduper-secret-key');
    const items = (list.json() as { items: Record<string, any>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.extraHeaders).toEqual({});

    // stored encrypted at rest, not plaintext
    const row = await h.db
      .selectFrom('llmProviderConfigs')
      .selectAll()
      .where('id', '=', provider.id as string)
      .executeTakeFirstOrThrow();
    expect(row.apiKeyEncrypted).toBeTruthy();
    expect(row.apiKeyEncrypted).not.toContain('sk-superduper-secret-key');
  });

  it('rejects an unknown provider kind', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/llm/providers',
      payload: { name: 'Bad', kind: 'totally-fake', model: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as any).error.code).toBe('bad_request');
  });

  it('masks the env var value when apiKeyEnv is set', async () => {
    process.env.DONNA_ROUTE_TEST_KEY = 'env-value-123456';
    const provider = await createProvider({ apiKeyEnv: 'DONNA_ROUTE_TEST_KEY' });
    expect(provider.hasStoredKey).toBe(false);
    expect(provider.apiKeyMasked).toBe(maskSecret('env-value-123456'));
  });

  it('PATCH apiKey: null clears the stored key', async () => {
    const provider = await createProvider({ apiKey: 'sk-clear-me-please' });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/llm/providers/${provider.id as string}`,
      payload: { apiKey: null, name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    const updated = (res.json() as { provider: Record<string, any> }).provider;
    expect(updated.name).toBe('Renamed');
    expect(updated.hasStoredKey).toBe(false);
    expect(updated.apiKeyMasked).toBeNull();
    expect(updated).not.toHaveProperty('apiKeyEncrypted');
  });

  it('accepts SQLite-style 0/1 for boolean fields', async () => {
    const provider = await createProvider({ isLocal: 1, supportsEmbeddings: 0 });
    expect(provider.isLocal).toBe(1);
    expect(provider.supportsEmbeddings).toBe(0);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/llm/providers/${provider.id as string}`,
      payload: { enabled: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { provider: Record<string, any> }).provider.enabled).toBe(0);

    const reEnabled = await h.app.inject({
      method: 'PATCH',
      url: `/api/llm/providers/${provider.id as string}`,
      payload: { enabled: 1, supportsEmbeddings: 1 },
    });
    expect(reEnabled.statusCode).toBe(200);
    const updated = (reEnabled.json() as { provider: Record<string, any> }).provider;
    expect(updated.enabled).toBe(1);
    expect(updated.supportsEmbeddings).toBe(1);
  });

  it('audits settings.updated on provider mutations with name/kind metadata only', async () => {
    await createProvider({ apiKey: 'sk-audit-secret' });
    const rows = await h.db
      .selectFrom('auditLogs')
      .selectAll()
      .where('workspaceId', '=', h.workspaceId)
      .where('eventType', '=', 'settings.updated')
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadata).toContain('"provider":"My Provider"');
    expect(rows[0]?.metadata).toContain('"kind":"openai"');
    expect(JSON.stringify(rows)).not.toContain('sk-audit-secret');
  });

  it('DELETE removes the provider and its routes', async () => {
    const provider = await createProvider();
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/llm/routes/chat',
      payload: { providerConfigId: provider.id },
    });
    expect(put.statusCode).toBe(200);
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/llm/providers/${provider.id as string}`,
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as any).ok).toBe(true);
    const routes = await h.app.inject({ method: 'GET', url: '/api/llm/routes' });
    expect((routes.json() as any).routes.chat).toBeNull();
    const missing = await h.app.inject({
      method: 'DELETE',
      url: `/api/llm/providers/${provider.id as string}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('PUT routes/:task then clientForTask resolves the routed provider + modelOverride', async () => {
    await createProvider({ name: 'First', model: 'first-model' });
    const second = await createProvider({ name: 'Second', model: 'second-model' });

    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/llm/routes/digest',
      payload: { providerConfigId: second.id, modelOverride: 'digest-special' },
    });
    expect(put.statusCode).toBe(200);
    const route = (put.json() as { route: Record<string, any> }).route;
    expect(route.task).toBe('digest');
    expect(route.providerConfigId).toBe(second.id);
    expect(route.modelOverride).toBe('digest-special');
    expect(route.params).toEqual({});

    const routed = await h.ctx.services.llm.clientForTask(h.workspaceId, 'digest');
    expect(routed.providerConfigId).toBe(second.id);
    expect(routed.model).toBe('digest-special');
    expect(routed.providerName).toBe('Second');

    const get = await h.app.inject({ method: 'GET', url: '/api/llm/routes' });
    const routes = (get.json() as any).routes;
    expect(routes.digest).toEqual({
      providerConfigId: second.id,
      modelOverride: 'digest-special',
    });
    expect(routes.chat).toBeNull();
  });

  it('PUT routes validates the task name and provider existence', async () => {
    const bad = await h.app.inject({
      method: 'PUT',
      url: '/api/llm/routes/not-a-task',
      payload: { providerConfigId: 'llm_x' },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await h.app.inject({
      method: 'PUT',
      url: '/api/llm/routes/chat',
      payload: { providerConfigId: 'llm_does_not_exist' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('GET status reports demoMode true when nothing is configured', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/llm/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.demoMode).toBe(true);
    expect(body.tasks.chat.providerName).toBe('Demo (mock)');
    expect(body.tasks.embedding).toBeNull();
  });

  it('POST :id/health on a mock-kind provider returns ok', async () => {
    const provider = await createProvider({ kind: 'mock', model: 'mock' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/llm/providers/${provider.id as string}/health`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.latencyMs).toBe('number');
    expect(typeof body.message).toBe('string');

    const models = await h.app.inject({
      method: 'GET',
      url: `/api/llm/providers/${provider.id as string}/models`,
    });
    expect(models.statusCode).toBe(200);
    expect(Array.isArray((models.json() as any).models)).toBe(true);
  });

  it('GET calls returns logged calls newest first with parsed JSON fields', async () => {
    const routed = await h.ctx.services.llm.clientForTask(
      h.workspaceId,
      'chat',
      { conversationId: 'cnv_42' },
      h.userId,
    );
    await routed.client.chat(
      { model: routed.model, messages: [{ role: 'user', content: 'hello there' }] },
      'chat',
    );

    const body = await vi.waitFor(async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/llm/calls?limit=10' });
      expect(res.statusCode).toBe(200);
      const json = res.json() as { items: Record<string, any>[] };
      expect(json.items.length).toBe(1);
      return json;
    });
    const call = body.items[0];
    expect(call).toMatchObject({
      providerKind: 'mock',
      task: 'chat',
      status: 'success',
      purposeRef: { conversationId: 'cnv_42' },
      userId: h.userId,
    });
    expect(call?.requestSummary).toMatchObject({ messageCount: 1 });
    expect(JSON.stringify(body)).not.toContain('hello there');
  });
});
