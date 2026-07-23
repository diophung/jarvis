import { createDefaultRegistry } from '@jarvis/connectors';
import { newId, nowIso, toJson } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from './config.js';
import type {
  AppContext,
  DigestService,
  DigestWithItems,
  IngestionService,
  Services,
} from './context.js';
import { SETTING_KEYS } from './context.js';
import { createAuditService } from './services/audit.js';
import { createSettingsService } from './services/settings.js';
import { createTestDb, seedWorkspace } from './test/helpers.js';
import { createWorkerLoop } from './worker-loop.js';

const HOUR_MS = 3_600_000;

interface DigestStub extends DigestService {
  calls: Array<{ workspaceId: string; userId: string; kind: string }>;
}

function stubDigest(): DigestStub {
  const calls: DigestStub['calls'] = [];
  return {
    calls,
    async generate(workspaceId, userId, opts) {
      calls.push({ workspaceId, userId, kind: opts.kind });
      return { id: newId('dig'), items: [] } as Partial<DigestWithItems> as DigestWithItems;
    },
    async list() {
      return [];
    },
    async get() {
      return null;
    },
  };
}

interface IngestionStub extends IngestionService {
  syncCalls: number;
}

function stubIngestion(): IngestionStub {
  const stub: IngestionStub = {
    syncCalls: 0,
    async syncAccount() {
      throw new Error('not used in worker tests');
    },
    async syncDueAccounts() {
      stub.syncCalls += 1;
      return 0;
    },
  };
  return stub;
}

async function makeWorld() {
  const db = await createTestDb();
  const seeded = await seedWorkspace(db);
  const settings = createSettingsService({ db });
  const audit = createAuditService({ db });
  const digest = stubDigest();
  const ingestion = stubIngestion();
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { settings, audit, digest, ingestion } as Partial<Services> as Services,
  };
  return { db, settings, digest, ingestion, ctx, ...seeded };
}

async function insertPendingApproval(
  db: Db,
  workspaceId: string,
  userId: string,
  expiresAt: string | null,
): Promise<string> {
  const id = newId('apr');
  const now = nowIso();
  await db
    .insertInto('approvalRequests')
    .values({
      id,
      workspaceId,
      userId,
      agentActionId: newId('act'),
      capability: 'email.send',
      actionType: 'send_email',
      targetProvider: 'mock-email',
      targetAccountId: null,
      targetRef: toJson({}),
      riskLevel: 'high',
      reason: 'test',
      preview: toJson({ summary: 'send an email' }),
      status: 'pending',
      requestedAt: now,
      decidedAt: null,
      decisionNote: null,
      conversationId: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

describe('worker loop tick', () => {
  it('triggers a past-due scheduled digest exactly once, then not again', async () => {
    const { settings, digest, ingestion, ctx, workspaceId, userId } = await makeWorld();
    await settings.set(workspaceId, SETTING_KEYS.digestSchedule, {
      cron: '0 8 * * *',
      enabled: true,
    });
    // Last run 25h ago -> the daily 08:00 occurrence since then is past due.
    await settings.set(
      workspaceId,
      SETTING_KEYS.digestLastScheduledAt,
      new Date(Date.now() - 25 * HOUR_MS).toISOString(),
    );

    const loop = createWorkerLoop(ctx);
    await loop.tick();

    expect(digest.calls).toEqual([{ workspaceId, userId, kind: 'scheduled' }]);
    const last = await settings.get<string | null>(
      workspaceId,
      SETTING_KEYS.digestLastScheduledAt,
      null,
    );
    expect(last).not.toBeNull();
    expect(Date.now() - Date.parse(last!)).toBeLessThan(60_000);

    // Second tick: lastScheduledAt advanced, so nothing is due.
    await loop.tick();
    expect(digest.calls).toHaveLength(1);

    // syncDueAccounts runs every tick.
    expect(ingestion.syncCalls).toBe(2);
  });

  it('does not generate when the schedule is disabled', async () => {
    const { settings, digest, ctx, workspaceId } = await makeWorld();
    await settings.set(workspaceId, SETTING_KEYS.digestSchedule, {
      cron: '0 8 * * *',
      enabled: false,
    });
    await settings.set(
      workspaceId,
      SETTING_KEYS.digestLastScheduledAt,
      new Date(Date.now() - 25 * HOUR_MS).toISOString(),
    );
    const loop = createWorkerLoop(ctx);
    await loop.tick();
    expect(digest.calls).toHaveLength(0);
  });

  it('falls back to the default enabled daily schedule when the setting is absent', async () => {
    const { digest, ctx, workspaceId, userId } = await makeWorld();
    const loop = createWorkerLoop(ctx);
    // Default is { cron: '0 7 * * *', enabled: true } (matches the bootstrap
    // seed); the 24h lookback always contains one 07:00 occurrence.
    await loop.tick();
    expect(digest.calls).toEqual([{ workspaceId, userId, kind: 'scheduled' }]);
  });

  it('skips a tick while a previous tick is still running, then resumes', async () => {
    const { settings, digest, ingestion, ctx, workspaceId } = await makeWorld();
    await settings.set(workspaceId, SETTING_KEYS.digestSchedule, {
      cron: '0 8 * * *',
      enabled: true,
    });
    await settings.set(
      workspaceId,
      SETTING_KEYS.digestLastScheduledAt,
      new Date(Date.now() - 25 * HOUR_MS).toISOString(),
    );

    // Make the first digest.generate hang on a deferred promise (a real-LLM
    // digest can outlast the tick interval).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hung = false;
    const originalGenerate = digest.generate.bind(digest);
    digest.generate = async (wsId, usrId, opts) => {
      const result = await originalGenerate(wsId, usrId, opts);
      if (!hung) {
        hung = true;
        await gate;
      }
      return result;
    };

    const loop = createWorkerLoop(ctx);
    const first = loop.tick();
    await vi.waitFor(() => expect(digest.calls).toHaveLength(1));

    // Reentrant tick: returns without generating again or running sub-jobs.
    await loop.tick();
    expect(digest.calls).toHaveLength(1);
    expect(ingestion.syncCalls).toBe(0);

    release();
    await first;
    expect(ingestion.syncCalls).toBe(1);

    // The latch is freed: the next tick runs normally.
    await loop.tick();
    expect(ingestion.syncCalls).toBe(2);
  });

  it('expires overdue pending approvals and audits them', async () => {
    const { db, ctx, workspaceId, userId } = await makeWorld();
    const overdue = await insertPendingApproval(
      db,
      workspaceId,
      userId,
      new Date(Date.now() - HOUR_MS).toISOString(),
    );
    const future = await insertPendingApproval(
      db,
      workspaceId,
      userId,
      new Date(Date.now() + HOUR_MS).toISOString(),
    );
    const noExpiry = await insertPendingApproval(db, workspaceId, userId, null);

    const loop = createWorkerLoop(ctx);
    await loop.tick();

    const rows = await db.selectFrom('approvalRequests').select(['id', 'status']).execute();
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(overdue)).toBe('expired');
    expect(byId.get(future)).toBe('pending');
    expect(byId.get(noExpiry)).toBe('pending');

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'approval.expired')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.targetId).toBe(overdue);
    expect(audits[0]!.actor).toBe('worker');

    // Already-expired approvals are not re-expired on the next tick.
    await loop.tick();
    const auditsAfter = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'approval.expired')
      .execute();
    expect(auditsAfter).toHaveLength(1);
  });

  it('start() schedules ticks and stop() halts them', async () => {
    const { ingestion, ctx } = await makeWorld();
    const loop = createWorkerLoop(ctx, { tickMs: 20 });
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    loop.stop();
    // Let any in-flight tick drain before snapshotting.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = ingestion.syncCalls;
    expect(after).toBeGreaterThanOrEqual(2); // immediate tick + at least one interval tick
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ingestion.syncCalls).toBe(after);
  });
});
