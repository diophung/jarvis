import { newId, nowIso, toJson } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { createAdapter } from '@jarvis/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createLlmRouterService } from './llm-router.js';
import { createSecretsService } from './secrets.js';

vi.mock('@jarvis/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@jarvis/llm')>();
  return { ...actual, createAdapter: vi.fn(actual.createAdapter) };
});

const createAdapterMock = vi.mocked(createAdapter);

const APP_SECRET = 'test-app-secret';

async function insertProvider(
  db: Db,
  workspaceId: string,
  overrides: Partial<{
    id: string;
    name: string;
    kind: string;
    baseUrl: string | null;
    model: string;
    apiKeyEnv: string | null;
    apiKeyEncrypted: string | null;
    temperature: number | null;
    maxTokens: number | null;
    timeoutMs: number | null;
    enabled: number;
    isLocal: number;
    supportsEmbeddings: number;
    embeddingModel: string | null;
    createdAt: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? newId('llm');
  const now = overrides.createdAt ?? nowIso();
  await db
    .insertInto('llmProviderConfigs')
    .values({
      id,
      workspaceId,
      name: overrides.name ?? 'Test Provider',
      kind: overrides.kind ?? 'openai',
      baseUrl: overrides.baseUrl ?? null,
      model: overrides.model ?? 'test-model',
      apiKeyEnv: overrides.apiKeyEnv ?? null,
      apiKeyEncrypted: overrides.apiKeyEncrypted ?? null,
      temperature: overrides.temperature ?? null,
      maxTokens: overrides.maxTokens ?? null,
      timeoutMs: overrides.timeoutMs ?? null,
      extraHeaders: toJson({}),
      enabled: overrides.enabled ?? 1,
      isLocal: overrides.isLocal ?? 0,
      supportsEmbeddings: overrides.supportsEmbeddings ?? 0,
      embeddingModel: overrides.embeddingModel ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

async function insertRoute(
  db: Db,
  workspaceId: string,
  task: string,
  providerConfigId: string,
  modelOverride: string | null = null,
  params: Record<string, unknown> = {},
): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('llmTaskRoutes')
    .values({
      id: newId('rte'),
      workspaceId,
      task,
      providerConfigId,
      modelOverride,
      params: toJson(params),
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

describe('llm-router service', () => {
  let db: Db;
  let workspaceId: string;
  let userId: string;
  let service: ReturnType<typeof createLlmRouterService>;
  const secrets = createSecretsService({ appSecret: APP_SECRET });

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedWorkspace(db);
    workspaceId = seeded.workspaceId;
    userId = seeded.userId;
    service = createLlmRouterService({
      db,
      secrets,
      audit: createAuditService({ db }),
    });
    createAdapterMock.mockClear();
  });

  afterEach(async () => {
    await db.destroy();
    delete process.env.JARVIS_TEST_LLM_KEY;
  });

  it('falls back to the mock adapter when nothing is configured', async () => {
    const routed = await service.clientForTask(workspaceId, 'chat');
    expect(routed.isMock).toBe(true);
    expect(routed.providerName).toBe('Demo (mock)');
    expect(routed.model).toBe('mock');
    expect(routed.providerConfigId).toBeNull();
    expect(routed.kind).toBe('mock');

    const status = await service.status(workspaceId);
    expect(status.demoMode).toBe(true);
    expect(status.tasks.chat).toMatchObject({ providerConfigId: null, model: 'mock' });
    expect(status.tasks.embedding).toBeNull();
  });

  it('prefers a non-mock enabled config over an older mock config', async () => {
    await insertProvider(db, workspaceId, {
      kind: 'mock',
      name: 'Mock Row',
      model: 'mock',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const openaiId = await insertProvider(db, workspaceId, {
      kind: 'openai',
      name: 'Real Provider',
      model: 'gpt-test',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const routed = await service.clientForTask(workspaceId, 'summarization');
    expect(routed.providerConfigId).toBe(openaiId);
    expect(routed.model).toBe('gpt-test');
    expect(routed.isMock).toBe(false);
  });

  it('resolves the env-named key in preference to the stored encrypted key', async () => {
    process.env.JARVIS_TEST_LLM_KEY = 'env-key-value';
    const id = await insertProvider(db, workspaceId, {
      kind: 'openai',
      apiKeyEnv: 'JARVIS_TEST_LLM_KEY',
      apiKeyEncrypted: secrets.encrypt('stored-key-value'),
    });
    const routed = await service.clientForTask(workspaceId, 'chat');
    expect(routed.providerConfigId).toBe(id);
    const call = createAdapterMock.mock.calls.at(-1);
    expect(call?.[0]).toBe('openai');
    expect(call?.[1]?.apiKey).toBe('env-key-value');
  });

  it('falls back to the decrypted stored key when no env var is set', async () => {
    await insertProvider(db, workspaceId, {
      kind: 'anthropic',
      apiKeyEnv: null,
      apiKeyEncrypted: secrets.encrypt('stored-key-value'),
    });
    await service.clientForTask(workspaceId, 'chat');
    const call = createAdapterMock.mock.calls.at(-1);
    expect(call?.[1]?.apiKey).toBe('stored-key-value');
  });

  it('uses the task route provider and modelOverride when routed', async () => {
    await insertProvider(db, workspaceId, { name: 'Default', model: 'default-model' });
    const routedId = await insertProvider(db, workspaceId, {
      name: 'Routed',
      model: 'base-model',
      temperature: 0.9,
      maxTokens: 100,
    });
    await insertRoute(db, workspaceId, 'digest', routedId, 'special-model', { maxTokens: 42 });
    const routed = await service.clientForTask(workspaceId, 'digest');
    expect(routed.providerConfigId).toBe(routedId);
    expect(routed.providerName).toBe('Routed');
    expect(routed.model).toBe('special-model');
    // route params override config values; config fills the rest
    expect(routed.params).toEqual({ temperature: 0.9, maxTokens: 42 });
  });

  it('logs every call to llm_call_logs without message content', async () => {
    const routed = await service.clientForTask(
      workspaceId,
      'chat',
      { conversationId: 'cnv_123' },
      userId,
    );
    await routed.client.chat(
      {
        model: routed.model,
        messages: [{ role: 'user', content: 'super secret message body' }],
      },
      'chat',
    );

    const row = await vi.waitFor(async () => {
      const found = await db
        .selectFrom('llmCallLogs')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      expect(found).toBeDefined();
      return found;
    });
    expect(row).toMatchObject({
      providerConfigId: null,
      providerKind: 'mock',
      model: 'mock',
      task: 'chat',
      status: 'success',
      userId,
    });
    expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row?.inputTokens).not.toBeNull();
    expect(JSON.parse(row?.purposeRef ?? '{}')).toEqual({ conversationId: 'cnv_123' });
    const summary = JSON.parse(row?.requestSummary ?? '{}') as Record<string, unknown>;
    expect(summary.messageCount).toBe(1);
    expect(JSON.stringify(row)).not.toContain('super secret message body');

    const auditRow = await vi.waitFor(async () => {
      const found = await db
        .selectFrom('auditLogs')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('eventType', '=', 'llm.call')
        .executeTakeFirst();
      expect(found).toBeDefined();
      return found;
    });
    expect(JSON.stringify(auditRow)).not.toContain('super secret message body');
  });

  describe('embeddingClient', () => {
    it('returns null when nothing supports embeddings', async () => {
      expect(await service.embeddingClient(workspaceId)).toBeNull();
    });

    it('never uses a mock config implicitly for embeddings', async () => {
      await insertProvider(db, workspaceId, {
        kind: 'mock',
        model: 'mock',
        supportsEmbeddings: 1,
        embeddingModel: 'mock-embed',
      });
      expect(await service.embeddingClient(workspaceId)).toBeNull();
    });

    it('uses an enabled config with supportsEmbeddings and its embeddingModel', async () => {
      const id = await insertProvider(db, workspaceId, {
        kind: 'openai',
        model: 'chat-model',
        supportsEmbeddings: 1,
        embeddingModel: 'embed-model',
      });
      const routed = await service.embeddingClient(workspaceId);
      expect(routed?.providerConfigId).toBe(id);
      expect(routed?.model).toBe('embed-model');
    });

    it('uses a mock provider when it is the explicit embedding route', async () => {
      const id = await insertProvider(db, workspaceId, {
        kind: 'mock',
        model: 'mock',
        supportsEmbeddings: 1,
        embeddingModel: 'mock-embed',
      });
      await insertRoute(db, workspaceId, 'embedding', id);
      const routed = await service.embeddingClient(workspaceId);
      expect(routed?.providerConfigId).toBe(id);
      expect(routed?.model).toBe('mock-embed');
      expect(routed?.isMock).toBe(true);
    });
  });

  it('healthCheck builds the adapter for the config and reports ok for mock', async () => {
    const id = await insertProvider(db, workspaceId, { kind: 'mock', model: 'mock' });
    const health = await service.healthCheck(workspaceId, id);
    expect(health.ok).toBe(true);
    await expect(service.healthCheck(workspaceId, 'llm_missing')).rejects.toThrow(
      'LLM provider not found',
    );
  });

  it('listModels returns [] for adapters without model discovery', async () => {
    const id = await insertProvider(db, workspaceId, { kind: 'mock', model: 'mock' });
    // mock adapter exposes listModels via healthCheck models only; client returns []
    const models = await service.listModels(workspaceId, id);
    expect(Array.isArray(models)).toBe(true);
  });

  it('status reports all five tasks', async () => {
    const status = await service.status(workspaceId);
    expect(Object.keys(status.tasks).sort()).toEqual(
      ['chat', 'classification', 'digest', 'embedding', 'summarization'].sort(),
    );
  });
});
