/**
 * Tenant isolation: every repository/service read must be scoped to the
 * caller's workspace. These tests seed two tenants with look-alike data and
 * assert no read or mutation crosses the boundary.
 */
import { nowIso } from '@donna/core';
import type { Db } from '@donna/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuditService } from './audit.js';
import { createLearningService } from './learning.js';
import { createMemoryService } from './memory.js';
import { createRetrievalService } from './retrieval.js';
import { createSettingsService } from './settings.js';
import { createSqlScanVectorStore } from './vector-store.js';
import { createIndexingService } from './indexing.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import type { LlmRouterService } from '../context.js';

let db: Db;
let tenantA: { workspaceId: string; userId: string };
let tenantB: { workspaceId: string; userId: string };

/** Router stub with no embedding provider (keyword-only retrieval). */
function nullRouter(): LlmRouterService {
  return {
    clientForTask: async () => {
      throw new Error('not used');
    },
    embeddingClient: async () => null,
    healthCheck: async () => {
      throw new Error('not used');
    },
    listModels: async () => [],
    status: async () => ({ demoMode: true, tasks: {} as never }),
  };
}

beforeEach(async () => {
  db = await createTestDb();
  tenantA = await seedWorkspace(db);
  tenantB = await seedWorkspace(db);
});

describe('tenant isolation', () => {
  it('memory entries never leak across workspaces', async () => {
    const audit = createAuditService({ db });
    const settings = createSettingsService({ db });
    const memory = createMemoryService({ db, settings, audit });
    await memory.create(tenantA.workspaceId, tenantA.userId, {
      kind: 'fact',
      content: 'Tenant A secret launch on Thursday',
      origin: 'explicit',
    });

    expect(await memory.list(tenantB.workspaceId)).toEqual([]);
    expect(await memory.relevant(tenantB.workspaceId, 'secret launch Thursday')).toEqual([]);
    // Cross-tenant mutation by id is a 404, not an update.
    const entry = (await memory.list(tenantA.workspaceId))[0]!;
    await expect(
      memory.update(tenantB.workspaceId, entry.id, { content: 'hijacked' }),
    ).rejects.toThrow(/not found/i);
    await expect(memory.remove(tenantB.workspaceId, entry.id)).rejects.toThrow(/not found/i);
  });

  it('learned preferences and their corrections are workspace-scoped', async () => {
    const audit = createAuditService({ db });
    const settings = createSettingsService({ db });
    const learning = createLearningService({ db, settings, audit });
    await learning.learnFromText(tenantA.workspaceId, tenantA.userId, {
      text: 'jane@acme.com is high priority',
      observedAt: nowIso(),
    });

    expect(await learning.list(tenantB.workspaceId, tenantB.userId)).toEqual([]);
    expect(await learning.search(tenantB.workspaceId, tenantB.userId, 'jane')).toEqual([]);
    expect(
      await learning.getPreferencesByContext(tenantB.workspaceId, tenantB.userId, {}),
    ).toEqual([]);

    const pref = (await learning.list(tenantA.workspaceId, tenantA.userId))[0]!;
    await expect(learning.explain(tenantB.workspaceId, pref.id)).rejects.toThrow(/not found/i);
    await expect(
      learning.applyUserCorrection(tenantB.workspaceId, tenantB.userId, pref.id, {
        action: 'mark_wrong',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('retrieval (keyword + vector) is workspace-scoped', async () => {
    const llm = nullRouter();
    const vectors = createSqlScanVectorStore({ db });
    const indexing = createIndexingService({ db, llm, vectors });
    const retrieval = createRetrievalService({ db, llm, vectors });
    await indexing.indexText(
      tenantA.workspaceId,
      'source_item',
      'itm_a',
      'quarterly compensation review for executives',
      { title: 'Comp review' },
    );

    const own = await retrieval.search(tenantA.workspaceId, 'compensation review');
    expect(own.results.length).toBeGreaterThan(0);
    const cross = await retrieval.search(tenantB.workspaceId, 'compensation review');
    expect(cross.results).toEqual([]);

    // Vector store search is workspace-scoped too.
    await vectors.upsert(tenantA.workspaceId, [
      { chunkId: own.results[0]!.chunkId, providerConfigId: null, model: 'm', vector: [1, 0] },
    ]);
    expect(await vectors.search(tenantB.workspaceId, 'm', [1, 0])).toEqual([]);
    expect((await vectors.search(tenantA.workspaceId, 'm', [1, 0])).length).toBeGreaterThan(0);
  });

  it('settings are workspace-scoped even with the cache warm', async () => {
    const settings = createSettingsService({ db });
    await settings.set(tenantA.workspaceId, 'digest.schedule', { cron: '0 7 * * *', enabled: true });
    expect(await settings.get(tenantB.workspaceId, 'digest.schedule', null)).toBeNull();
    expect(await settings.getAll(tenantB.workspaceId)).toEqual({});
  });
});
