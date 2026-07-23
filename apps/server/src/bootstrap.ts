import { newId, nowIso, toJson, type LlmTask } from '@jarvis/core';
import { DEMO_PEOPLE, DEMO_PROJECTS } from '@jarvis/connectors';
import type { Db } from '@jarvis/db';
import { ensureOwner } from './auth.js';
import type { AppConfig } from './config.js';
import type { Services } from './context.js';
import { SETTING_KEYS } from './context.js';

/**
 * Default model names seeded for env-configured providers. These are ONLY
 * editable defaults (Settings → AI Providers); nothing else references them.
 */
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  openaiEmbedding: 'text-embedding-3-small',
  gemini: 'gemini-2.5-flash',
  geminiEmbedding: 'gemini-embedding-001',
} as const;

export interface BootstrapResult {
  userId: string;
  workspaceId: string;
  seededDemo: boolean;
  seededProviders: number;
}

/** Idempotent first-boot setup. Safe to run on every server start. */
export async function bootstrap(
  db: Db,
  config: AppConfig,
  services: Services,
): Promise<BootstrapResult> {
  const { userId, workspaceId } = await ensureOwner(db, config);
  const now = nowIso();

  // Sweep zombie connector runs left 'running' by a previous process exit —
  // otherwise they sit in the UI as in-progress forever.
  await db
    .updateTable('connectorRuns')
    .set({
      status: 'error',
      completedAt: now,
      errors: toJson(['Interrupted by server restart']),
    })
    .where('status', '=', 'running')
    .execute();

  // ---- Default app settings (only when missing) ----
  const settings = await services.settings.getAll(workspaceId);
  if (settings[SETTING_KEYS.digestSchedule] === undefined) {
    await services.settings.set(workspaceId, SETTING_KEYS.digestSchedule, {
      cron: '0 7 * * *',
      enabled: true,
    });
  }
  if (settings[SETTING_KEYS.memoryEnabled] === undefined) {
    await services.settings.set(workspaceId, SETTING_KEYS.memoryEnabled, true);
  }
  if (settings[SETTING_KEYS.syncIntervalMinutes] === undefined) {
    await services.settings.set(workspaceId, SETTING_KEYS.syncIntervalMinutes, 15);
  }

  // ---- Seed LLM providers from env (only when none configured yet) ----
  let seededProviders = 0;
  const providerCount = await db
    .selectFrom('llmProviderConfigs')
    .select(db.fn.countAll<number>().as('n'))
    .executeTakeFirst();
  if (!providerCount || Number(providerCount.n) === 0) {
    const inserts: Array<{
      name: string;
      kind: string;
      baseUrl: string | null;
      model: string;
      apiKeyEnv: string | null;
      isLocal: number;
      supportsEmbeddings: number;
      embeddingModel: string | null;
    }> = [];
    if (config.env.ANTHROPIC_API_KEY) {
      inserts.push({
        name: 'Anthropic Claude',
        kind: 'anthropic',
        baseUrl: null,
        model: DEFAULT_MODELS.anthropic,
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        isLocal: 0,
        supportsEmbeddings: 0,
        embeddingModel: null,
      });
    }
    if (config.env.OPENAI_API_KEY) {
      inserts.push({
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: null,
        model: DEFAULT_MODELS.openai,
        apiKeyEnv: 'OPENAI_API_KEY',
        isLocal: 0,
        supportsEmbeddings: 1,
        embeddingModel: DEFAULT_MODELS.openaiEmbedding,
      });
    }
    if (config.env.GEMINI_API_KEY) {
      inserts.push({
        name: 'Google Gemini',
        kind: 'gemini',
        baseUrl: null,
        model: DEFAULT_MODELS.gemini,
        apiKeyEnv: 'GEMINI_API_KEY',
        isLocal: 0,
        supportsEmbeddings: 1,
        embeddingModel: DEFAULT_MODELS.geminiEmbedding,
      });
    }
    if (config.env.JARVIS_LOCAL_LLM_BASE_URL && config.env.JARVIS_LOCAL_LLM_MODEL) {
      inserts.push({
        name: 'Local inference',
        kind: 'openai_compatible',
        baseUrl: config.env.JARVIS_LOCAL_LLM_BASE_URL,
        model: config.env.JARVIS_LOCAL_LLM_MODEL,
        apiKeyEnv: config.env.JARVIS_LOCAL_LLM_API_KEY_ENV ?? null,
        isLocal: 1,
        supportsEmbeddings: config.env.JARVIS_LOCAL_EMBEDDING_MODEL ? 1 : 0,
        embeddingModel: config.env.JARVIS_LOCAL_EMBEDDING_MODEL ?? null,
      });
    }
    const ids: string[] = [];
    for (const p of inserts) {
      const id = newId('llm');
      ids.push(id);
      await db
        .insertInto('llmProviderConfigs')
        .values({
          id,
          workspaceId,
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl,
          model: p.model,
          apiKeyEnv: p.apiKeyEnv,
          apiKeyEncrypted: null,
          temperature: null,
          maxTokens: null,
          timeoutMs: null,
          extraHeaders: '{}',
          enabled: 1,
          isLocal: p.isLocal,
          supportsEmbeddings: p.supportsEmbeddings,
          embeddingModel: p.embeddingModel,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      seededProviders++;
    }
    // Default task routing: first provider for chat-ish tasks; first
    // embedding-capable provider for embeddings.
    if (ids.length > 0) {
      const primary = ids[0]!;
      const embedIdx = inserts.findIndex((p) => p.supportsEmbeddings === 1);
      const tasks: LlmTask[] = ['chat', 'summarization', 'digest', 'classification'];
      for (const task of tasks) {
        await db
          .insertInto('llmTaskRoutes')
          .values({
            id: newId('rte'),
            workspaceId,
            task,
            providerConfigId: primary,
            modelOverride: null,
            params: '{}',
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      }
      if (embedIdx >= 0) {
        await db
          .insertInto('llmTaskRoutes')
          .values({
            id: newId('rte'),
            workspaceId,
            task: 'embedding',
            providerConfigId: ids[embedIdx]!,
            modelOverride: null,
            params: '{}',
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      }
    }
  }

  // ---- Demo seed (mock sources + people + projects + initial sync) ----
  let seededDemo = false;
  if (config.env.JARVIS_DEMO_SEED) {
    const accountCount = await db
      .selectFrom('sourceAccounts')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    if (!accountCount || Number(accountCount.n) === 0) {
      seededDemo = true;

      // People
      const personIdByEmail = new Map<string, string>();
      for (const p of DEMO_PEOPLE) {
        const id = newId('per');
        for (const e of p.emails) personIdByEmail.set(e, id);
        await db
          .insertInto('people')
          .values({
            id,
            workspaceId,
            displayName: p.name,
            emails: toJson(p.emails),
            handles: '[]',
            organizationId: null,
            title: p.title ?? null,
            importance: p.importance,
            isSelf: p.isSelf ? 1 : 0,
            interactionCount: 0,
            lastInteractionAt: null,
            notes: null,
            origin: 'connector',
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      }

      // Projects
      for (const pr of DEMO_PROJECTS) {
        const dueAt =
          pr.dueAtOffsetDays != null
            ? new Date(Date.now() + pr.dueAtOffsetDays * 24 * 60 * 60 * 1000).toISOString()
            : null;
        await db
          .insertInto('projects')
          .values({
            id: newId('prj'),
            workspaceId,
            name: pr.name,
            description: pr.description ?? null,
            status: 'active',
            priority: pr.priority,
            keywords: toJson(pr.keywords),
            stakeholderPeopleIds: '[]',
            dueAt,
            origin: 'user',
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      }

      // Mock source accounts
      const mockProviders: Array<{ provider: string; category: string; name: string }> = [
        { provider: 'mock-email', category: 'email', name: 'Work Email (demo)' },
        { provider: 'mock-chat', category: 'chat', name: 'Team Chat (demo)' },
        { provider: 'mock-calendar', category: 'calendar', name: 'Calendar (demo)' },
        { provider: 'mock-storage', category: 'storage', name: 'Cloud Drive (demo)' },
      ];
      const accountIds: string[] = [];
      for (const m of mockProviders) {
        const id = newId('acc');
        accountIds.push(id);
        await db
          .insertInto('sourceAccounts')
          .values({
            id,
            workspaceId,
            userId,
            provider: m.provider,
            category: m.category,
            displayName: m.name,
            status: 'connected',
            authRef: null,
            scopes: '[]',
            capabilities: '["read","list","search"]',
            settings: '{}',
            lastSyncAt: null,
            syncCursor: null,
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      }

      // Initial full sync + prioritization
      for (const accountId of accountIds) {
        try {
          await services.ingestion.syncAccount(workspaceId, accountId, {
            mode: 'full',
            triggeredBy: 'connect',
          });
        } catch (err) {
          // Demo seeding must never block boot.
          console.error(`[bootstrap] demo sync failed for ${accountId}:`, err);
        }
      }
      try {
        await services.scoring.rescoreWorkspace(workspaceId);
      } catch (err) {
        console.error('[bootstrap] demo rescore failed:', err);
      }

      await services.audit.log({
        workspaceId,
        userId,
        eventType: 'settings.updated',
        actor: 'system',
        summary: 'Demo workspace seeded with mock sources, people, and projects',
      });
    }
  }

  return { userId, workspaceId, seededDemo, seededProviders };
}
