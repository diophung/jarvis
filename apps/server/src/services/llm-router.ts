/**
 * LLM router: resolves which provider config (and model/params) serves each
 * task, wraps adapters in LlmClient instances whose usage events are
 * persisted to llm_call_logs (counts/sizes only — never message content) and
 * mirrored into the audit log as 'llm.call' events.
 *
 * Resolution order for a task:
 *   1. llm_task_routes row for (workspace, task) -> its provider config
 *   2. any enabled provider config (non-mock preferred, oldest first)
 *   3. the built-in mock adapter (demo mode; isMock = true)
 *
 * Embeddings never fall back to mock implicitly: embeddingClient returns
 * null when no configured provider supports embeddings, unless a mock
 * provider is the explicitly routed 'embedding' provider.
 */
import {
  fromJson,
  LLM_TASKS,
  newId,
  nowIso,
  toJson,
  type LlmProviderKind,
  type LlmTask,
} from '@jarvis/core';
import type { Db, LlmProviderConfigsTable } from '@jarvis/db';
import { createAdapter, LlmClient, type LlmHealth, type LlmUsageEvent } from '@jarvis/llm';
import type { AppConfig } from '../config.js';
import type { AuditService, LlmRouterService, LlmTaskStatus, RoutedLlm, SecretsService } from '../context.js';
import { notFound } from '../lib/http-errors.js';

export interface LlmRouterDeps {
  db: Db;
  secrets: SecretsService;
  audit: AuditService;
  config?: AppConfig;
}

type PurposeRef = { conversationId?: string; digestId?: string; sourceItemId?: string };
type ProviderRow = LlmProviderConfigsTable;
type RouteParams = { temperature?: number; maxTokens?: number };

export const MOCK_PROVIDER_NAME = 'Demo (mock)';
export const MOCK_MODEL = 'mock';

export function createLlmRouterService(deps: LlmRouterDeps): LlmRouterService {
  const { db, secrets, audit } = deps;

  async function loadConfig(workspaceId: string, id: string): Promise<ProviderRow | undefined> {
    return db
      .selectFrom('llmProviderConfigs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async function loadRoute(workspaceId: string, task: LlmTask) {
    return db
      .selectFrom('llmTaskRoutes')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('task', '=', task)
      .executeTakeFirst();
  }

  /** Any enabled config: prefer non-mock, then lowest createdAt. */
  async function fallbackConfig(workspaceId: string): Promise<ProviderRow | undefined> {
    const rows = await db
      .selectFrom('llmProviderConfigs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', 1)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.find((r) => r.kind !== 'mock') ?? rows[0];
  }

  /** Env-named key wins over the encrypted stored key. Never logged. */
  function resolveApiKey(cfg: ProviderRow): string | undefined {
    if (cfg.apiKeyEnv) {
      const fromEnv = secrets.env(cfg.apiKeyEnv);
      if (fromEnv) return fromEnv;
    }
    if (cfg.apiKeyEncrypted) {
      const decrypted = secrets.decrypt(cfg.apiKeyEncrypted);
      if (decrypted !== null) return decrypted;
    }
    return undefined;
  }

  function adapterFor(cfg: ProviderRow) {
    return createAdapter(cfg.kind as LlmProviderKind, {
      baseUrl: cfg.baseUrl ?? undefined,
      apiKey: resolveApiKey(cfg),
      extraHeaders: fromJson<Record<string, string>>(cfg.extraHeaders, {}),
      defaultTimeoutMs: cfg.timeoutMs ?? undefined,
    });
  }

  async function recordUsage(opts: {
    workspaceId: string;
    userId: string | null;
    providerConfigId: string | null;
    providerName: string;
    purposeRef: PurposeRef;
    event: LlmUsageEvent;
  }): Promise<void> {
    const { event } = opts;
    await db
      .insertInto('llmCallLogs')
      .values({
        id: newId('llg'),
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        providerConfigId: opts.providerConfigId,
        providerKind: event.providerKind,
        model: event.model,
        task: event.task,
        status: event.status,
        latencyMs: Math.max(0, Math.round(event.latencyMs)),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        error: event.error ?? null,
        requestSummary: toJson(event.requestSummary),
        purposeRef: toJson(opts.purposeRef),
        createdAt: nowIso(),
      })
      .execute();
    await audit.log({
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      eventType: 'llm.call',
      actor: 'system',
      targetType: 'llm_provider_config',
      targetId: opts.providerConfigId,
      summary: `LLM ${event.task} call via ${opts.providerName} (${event.model}) — ${event.status}`,
      metadata: {
        provider: opts.providerName,
        kind: event.providerKind,
        model: event.model,
        task: event.task,
        status: event.status,
        latencyMs: event.latencyMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      },
    });
  }

  function buildRouted(opts: {
    workspaceId: string;
    cfg: ProviderRow | null;
    modelOverride?: string | null;
    routeParams?: RouteParams;
    embeddingModelPreferred?: boolean;
    purposeRef?: PurposeRef;
    userId?: string | null;
  }): RoutedLlm {
    const { cfg } = opts;
    const providerConfigId = cfg?.id ?? null;
    const providerName = cfg?.name ?? MOCK_PROVIDER_NAME;
    const kind: LlmProviderKind = cfg ? (cfg.kind as LlmProviderKind) : 'mock';
    const baseModel =
      cfg === null
        ? MOCK_MODEL
        : opts.embeddingModelPreferred === true
          ? (cfg.embeddingModel ?? cfg.model)
          : cfg.model;
    const model = opts.modelOverride ?? baseModel;
    const params: RoutedLlm['params'] = {};
    const temperature = opts.routeParams?.temperature ?? cfg?.temperature ?? undefined;
    const maxTokens = opts.routeParams?.maxTokens ?? cfg?.maxTokens ?? undefined;
    if (temperature !== undefined && temperature !== null) params.temperature = temperature;
    if (maxTokens !== undefined && maxTokens !== null) params.maxTokens = maxTokens;
    const adapter = cfg ? adapterFor(cfg) : createAdapter('mock');
    const purposeRef = opts.purposeRef ?? {};
    const userId = opts.userId ?? null;
    const client = new LlmClient(adapter, {
      defaultTimeoutMs: cfg?.timeoutMs ?? undefined,
      onUsage: (event) => {
        void recordUsage({
          workspaceId: opts.workspaceId,
          userId,
          providerConfigId,
          providerName,
          purposeRef,
          event,
        }).catch(() => {
          // Usage logging must never break the actual call path.
        });
      },
    });
    return {
      client,
      model,
      params,
      providerConfigId,
      providerName,
      kind,
      isLocal: cfg ? cfg.isLocal === 1 : true,
      isMock: kind === 'mock',
    };
  }

  function toStatus(routed: RoutedLlm): LlmTaskStatus {
    return {
      providerConfigId: routed.providerConfigId,
      providerName: routed.providerName,
      model: routed.model,
      kind: routed.kind,
      isLocal: routed.isLocal,
    };
  }

  const clientForTask: LlmRouterService['clientForTask'] = async (
    workspaceId,
    task,
    purposeRef,
    userId,
  ) => {
    const route = await loadRoute(workspaceId, task);
    if (route?.providerConfigId) {
      const cfg = await loadConfig(workspaceId, route.providerConfigId);
      if (cfg && cfg.enabled === 1) {
        return buildRouted({
          workspaceId,
          cfg,
          modelOverride: route.modelOverride,
          routeParams: fromJson<RouteParams>(route.params, {}),
          purposeRef,
          userId,
        });
      }
    }
    const cfg = await fallbackConfig(workspaceId);
    return buildRouted({ workspaceId, cfg: cfg ?? null, purposeRef, userId });
  };

  const embeddingClient: LlmRouterService['embeddingClient'] = async (workspaceId) => {
    const route = await loadRoute(workspaceId, 'embedding');
    if (route?.providerConfigId) {
      const cfg = await loadConfig(workspaceId, route.providerConfigId);
      if (cfg && cfg.enabled === 1) {
        return buildRouted({
          workspaceId,
          cfg,
          modelOverride: route.modelOverride,
          routeParams: fromJson<RouteParams>(route.params, {}),
          embeddingModelPreferred: true,
        });
      }
    }
    // Implicit fallback: only non-mock providers that support embeddings.
    const rows = await db
      .selectFrom('llmProviderConfigs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', 1)
      .where('supportsEmbeddings', '=', 1)
      .where('kind', '!=', 'mock')
      .orderBy('createdAt', 'asc')
      .execute();
    const cfg = rows[0];
    if (!cfg) return null;
    return buildRouted({ workspaceId, cfg, embeddingModelPreferred: true });
  };

  return {
    clientForTask,
    embeddingClient,

    async healthCheck(workspaceId, providerConfigId): Promise<LlmHealth> {
      const cfg = await loadConfig(workspaceId, providerConfigId);
      if (!cfg) throw notFound('LLM provider not found');
      return adapterFor(cfg).healthCheck(cfg.model);
    },

    async listModels(workspaceId, providerConfigId): Promise<string[]> {
      const cfg = await loadConfig(workspaceId, providerConfigId);
      if (!cfg) throw notFound('LLM provider not found');
      const adapter = adapterFor(cfg);
      if (adapter.listModels === undefined) return [];
      return adapter.listModels();
    },

    async status(workspaceId) {
      const tasks = {} as Record<LlmTask, LlmTaskStatus | null>;
      let demoMode = true;
      for (const task of LLM_TASKS) {
        if (task === 'embedding') {
          const routed = await embeddingClient(workspaceId);
          tasks[task] = routed ? toStatus(routed) : null;
        } else {
          const routed = await clientForTask(workspaceId, task);
          tasks[task] = toStatus(routed);
          if (task === 'chat') demoMode = routed.isMock;
        }
      }
      return { demoMode, tasks };
    },
  };
}
