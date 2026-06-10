/**
 * LLM provider & routing endpoints (contract section "LLM providers & routing").
 *
 * Secrets discipline: `apiKeyEncrypted` is NEVER serialized. Responses carry
 * `hasStoredKey` plus `apiKeyMasked` (masked view of the env var value when
 * `apiKeyEnv` resolves, else of the decrypted stored key). Plaintext keys
 * submitted via POST/PATCH are encrypted immediately and discarded.
 */
import {
  fromJson,
  LLM_PROVIDER_KINDS,
  LLM_TASKS,
  newId,
  nowIso,
  toJson,
  type LlmCallLog,
  type LlmProviderConfig,
  type LlmProviderKind,
  type LlmTask,
  type LlmTaskRoute,
} from '@donna/core';
import type { LlmProviderConfigsTable, LlmTaskRoutesTable } from '@donna/db';
import { KIND_DEFAULTS } from '@donna/llm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { maskSecret } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/http-errors.js';

/** Public provider shape: no ciphertext, masked key view only. */
export interface LlmProviderConfigPublic extends Omit<LlmProviderConfig, 'apiKeyEncrypted'> {
  hasStoredKey: boolean;
  apiKeyMasked: string | null;
}

/** Accepts JSON booleans plus SQLite-style 0/1, normalized to a boolean. */
const BoolLike = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((v) => v === true || v === 1);

const ProviderCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(LLM_PROVIDER_KINDS),
  baseUrl: z.string().min(1).nullish(),
  model: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  maxTokens: z.number().int().positive().nullish(),
  timeoutMs: z.number().int().positive().nullish(),
  isLocal: BoolLike.optional(),
  supportsEmbeddings: BoolLike.optional(),
  embeddingModel: z.string().min(1).nullish(),
});

/** PATCH: same fields, all optional; `apiKey: null` clears the stored key. */
const ProviderPatchSchema = ProviderCreateSchema.partial().extend({
  apiKey: z.string().min(1).nullish(),
  enabled: BoolLike.optional(),
});

const RoutePutSchema = z.object({
  providerConfigId: z.string().min(1),
  modelOverride: z.string().min(1).nullish(),
});

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request body';
  const path = issue.path.join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

function toRouteEntity(row: LlmTaskRoutesTable): LlmTaskRoute {
  return {
    ...row,
    task: row.task as LlmTask,
    params: fromJson<LlmTaskRoute['params']>(row.params, {}),
  };
}

export function registerLlmRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const { secrets, audit, llm } = ctx.services;

  function toPublicProvider(row: LlmProviderConfigsTable): LlmProviderConfigPublic {
    const { apiKeyEncrypted, ...rest } = row;
    let masked: string | null = null;
    if (row.apiKeyEnv) {
      const envValue = secrets.env(row.apiKeyEnv);
      if (envValue) masked = maskSecret(envValue);
    }
    if (masked === null && apiKeyEncrypted !== null) {
      const decrypted = secrets.decrypt(apiKeyEncrypted);
      if (decrypted !== null) masked = maskSecret(decrypted);
    }
    return {
      ...rest,
      kind: row.kind as LlmProviderKind,
      extraHeaders: fromJson<Record<string, string>>(row.extraHeaders, {}),
      hasStoredKey: apiKeyEncrypted !== null,
      apiKeyMasked: masked,
    };
  }

  async function loadProvider(
    workspaceId: string,
    id: string,
  ): Promise<LlmProviderConfigsTable | undefined> {
    return db
      .selectFrom('llmProviderConfigs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async function auditSettingsUpdate(
    workspaceId: string,
    userId: string,
    summary: string,
    metadata: { provider: string; kind: string; task?: string },
    targetId: string | null,
  ): Promise<void> {
    await audit.log({
      workspaceId,
      userId,
      eventType: 'settings.updated',
      actor: 'user',
      targetType: 'llm_provider_config',
      targetId,
      summary,
      metadata,
    });
  }

  app.get('/api/llm/providers', async (request) => {
    const rows = await db
      .selectFrom('llmProviderConfigs')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
    return { items: rows.map((row) => toPublicProvider(row)) };
  });

  app.post('/api/llm/providers', async (request, reply) => {
    const parsed = ProviderCreateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(zodMessage(parsed.error));
    const body = parsed.data;
    const defaults = KIND_DEFAULTS[body.kind];
    const now = nowIso();
    const row: LlmProviderConfigsTable = {
      id: newId('llm'),
      workspaceId: request.workspaceId,
      name: body.name,
      kind: body.kind,
      baseUrl: body.baseUrl ?? null,
      model: body.model,
      apiKeyEnv: body.apiKeyEnv ?? null,
      apiKeyEncrypted: body.apiKey !== undefined ? secrets.encrypt(body.apiKey) : null,
      temperature: body.temperature ?? null,
      maxTokens: body.maxTokens ?? null,
      timeoutMs: body.timeoutMs ?? null,
      extraHeaders: toJson({}),
      enabled: 1,
      isLocal: (body.isLocal ?? defaults.isLocalByDefault) ? 1 : 0,
      supportsEmbeddings: (body.supportsEmbeddings ?? defaults.supportsEmbeddings) ? 1 : 0,
      embeddingModel: body.embeddingModel ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insertInto('llmProviderConfigs').values(row).execute();
    await auditSettingsUpdate(
      request.workspaceId,
      request.userId,
      `LLM provider added: ${body.name}`,
      { provider: body.name, kind: body.kind },
      row.id,
    );
    reply.code(201);
    return { provider: toPublicProvider(row) };
  });

  app.patch<{ Params: { id: string } }>('/api/llm/providers/:id', async (request) => {
    const existing = await loadProvider(request.workspaceId, request.params.id);
    if (!existing) throw notFound('LLM provider not found');
    const parsed = ProviderPatchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(zodMessage(parsed.error));
    const body = parsed.data;

    const patch: Partial<LlmProviderConfigsTable> = { updatedAt: nowIso() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
    if (body.model !== undefined) patch.model = body.model;
    if (body.apiKeyEnv !== undefined) patch.apiKeyEnv = body.apiKeyEnv;
    if (body.apiKey !== undefined) {
      patch.apiKeyEncrypted = body.apiKey === null ? null : secrets.encrypt(body.apiKey);
    }
    if (body.temperature !== undefined) patch.temperature = body.temperature;
    if (body.maxTokens !== undefined) patch.maxTokens = body.maxTokens;
    if (body.timeoutMs !== undefined) patch.timeoutMs = body.timeoutMs;
    if (body.isLocal !== undefined) patch.isLocal = body.isLocal ? 1 : 0;
    if (body.supportsEmbeddings !== undefined) {
      patch.supportsEmbeddings = body.supportsEmbeddings ? 1 : 0;
    }
    if (body.embeddingModel !== undefined) patch.embeddingModel = body.embeddingModel;
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;

    await db
      .updateTable('llmProviderConfigs')
      .set(patch)
      .where('id', '=', existing.id)
      .execute();
    const updated = await loadProvider(request.workspaceId, existing.id);
    if (!updated) throw notFound('LLM provider not found');
    await auditSettingsUpdate(
      request.workspaceId,
      request.userId,
      `LLM provider updated: ${updated.name}`,
      { provider: updated.name, kind: updated.kind },
      updated.id,
    );
    return { provider: toPublicProvider(updated) };
  });

  app.delete<{ Params: { id: string } }>('/api/llm/providers/:id', async (request) => {
    const existing = await loadProvider(request.workspaceId, request.params.id);
    if (!existing) throw notFound('LLM provider not found');
    await db.deleteFrom('llmProviderConfigs').where('id', '=', existing.id).execute();
    await db
      .deleteFrom('llmTaskRoutes')
      .where('workspaceId', '=', request.workspaceId)
      .where('providerConfigId', '=', existing.id)
      .execute();
    await auditSettingsUpdate(
      request.workspaceId,
      request.userId,
      `LLM provider removed: ${existing.name}`,
      { provider: existing.name, kind: existing.kind },
      existing.id,
    );
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/llm/providers/:id/health', async (request) => {
    return llm.healthCheck(request.workspaceId, request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/llm/providers/:id/models', async (request) => {
    const models = await llm.listModels(request.workspaceId, request.params.id);
    return { models };
  });

  app.get('/api/llm/routes', async (request) => {
    const rows = await db
      .selectFrom('llmTaskRoutes')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .execute();
    const routes = {} as Record<
      LlmTask,
      { providerConfigId: string; modelOverride: string | null } | null
    >;
    for (const task of LLM_TASKS) {
      const row = rows.find((r) => r.task === task);
      routes[task] =
        row?.providerConfigId != null
          ? { providerConfigId: row.providerConfigId, modelOverride: row.modelOverride }
          : null;
    }
    return { routes };
  });

  app.put<{ Params: { task: string } }>('/api/llm/routes/:task', async (request) => {
    const task = request.params.task;
    if (!(LLM_TASKS as readonly string[]).includes(task)) {
      throw badRequest(`Unknown LLM task: ${task}`);
    }
    const parsed = RoutePutSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(zodMessage(parsed.error));
    const body = parsed.data;
    const provider = await loadProvider(request.workspaceId, body.providerConfigId);
    if (!provider) throw notFound('LLM provider not found');

    const now = nowIso();
    const existing = await db
      .selectFrom('llmTaskRoutes')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .where('task', '=', task)
      .executeTakeFirst();
    let row: LlmTaskRoutesTable;
    if (existing) {
      row = {
        ...existing,
        providerConfigId: provider.id,
        modelOverride: body.modelOverride ?? null,
        updatedAt: now,
      };
      await db
        .updateTable('llmTaskRoutes')
        .set({
          providerConfigId: row.providerConfigId,
          modelOverride: row.modelOverride,
          updatedAt: now,
        })
        .where('id', '=', existing.id)
        .execute();
    } else {
      row = {
        id: newId('rte'),
        workspaceId: request.workspaceId,
        task,
        providerConfigId: provider.id,
        modelOverride: body.modelOverride ?? null,
        params: toJson({}),
        createdAt: now,
        updatedAt: now,
      };
      await db.insertInto('llmTaskRoutes').values(row).execute();
    }
    await auditSettingsUpdate(
      request.workspaceId,
      request.userId,
      `LLM route updated: ${task} → ${provider.name}`,
      { provider: provider.name, kind: provider.kind, task },
      provider.id,
    );
    return { route: toRouteEntity(row) };
  });

  app.get('/api/llm/status', async (request) => {
    return llm.status(request.workspaceId);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/llm/calls', async (request) => {
    const parsedLimit = z.coerce
      .number()
      .int()
      .positive()
      .max(500)
      .safeParse(request.query.limit ?? 50);
    if (!parsedLimit.success) throw badRequest('Invalid limit');
    const rows = await db
      .selectFrom('llmCallLogs')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(parsedLimit.data)
      .execute();
    const items = rows.map(
      (row): LlmCallLog => ({
        ...row,
        providerKind: row.providerKind as LlmProviderKind,
        task: row.task as LlmTask,
        status: row.status as LlmCallLog['status'],
        requestSummary: fromJson<Record<string, unknown>>(row.requestSummary, {}),
        purposeRef: fromJson<LlmCallLog['purposeRef']>(row.purposeRef, {}),
      }),
    );
    return { items };
  });
}
