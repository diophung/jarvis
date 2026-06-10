/**
 * Background worker loop. Each tick runs three independent sub-jobs (each in
 * its own try/catch so one failure never blocks the others):
 *
 *  1. Scheduled digests: per workspace, when the digest.schedule setting is
 *     enabled and its cron has an occurrence between digest.lastScheduledAt
 *     (or 24h ago) and now, generate a 'scheduled' digest for the workspace
 *     owner and advance digest.lastScheduledAt.
 *  2. Connector syncs: ingestion.syncDueAccounts (interval-based, scheduled).
 *  3. Approval expiry: pending approval_requests past expiresAt become
 *     'expired' (audited as 'approval.expired').
 */
import { nowIso } from '@donna/core';
import { Cron } from 'croner';
import type { AppContext } from './context.js';
import { SETTING_KEYS } from './context.js';
import { DEFAULT_DIGEST_SCHEDULE } from './routes/digests.js';

const DAY_MS = 86_400_000;
const DEFAULT_TICK_MS = 60_000;

export interface WorkerLoop {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

interface DigestSchedule {
  cron: string;
  enabled: boolean;
}

export function createWorkerLoop(ctx: AppContext, opts: { tickMs?: number } = {}): WorkerLoop {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const { db } = ctx;
  const { settings, digest, ingestion, audit } = ctx.services;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runScheduledDigests(): Promise<void> {
    const workspaces = await db.selectFrom('workspaces').select(['id', 'ownerUserId']).execute();
    for (const ws of workspaces) {
      try {
        const schedule = await settings.get<DigestSchedule>(
          ws.id,
          SETTING_KEYS.digestSchedule,
          DEFAULT_DIGEST_SCHEDULE,
        );
        if (!schedule.enabled || schedule.cron.trim() === '') continue;

        const nowMs = Date.now();
        const lastScheduledAt = await settings.get<string | null>(
          ws.id,
          SETTING_KEYS.digestLastScheduledAt,
          null,
        );
        const lastMs = lastScheduledAt !== null ? Date.parse(lastScheduledAt) : Number.NaN;
        const after = Number.isNaN(lastMs) ? new Date(nowMs - DAY_MS) : new Date(lastMs);

        const next = new Cron(schedule.cron).nextRun(after);
        if (next === null || next.getTime() > nowMs) continue;

        await digest.generate(ws.id, ws.ownerUserId, { kind: 'scheduled' });
        await settings.set(ws.id, SETTING_KEYS.digestLastScheduledAt, nowIso());
      } catch (err) {
        console.error(`[worker] scheduled digest failed for workspace ${ws.id}`, err);
      }
    }
  }

  async function expireApprovals(): Promise<void> {
    const now = nowIso();
    const rows = await db
      .selectFrom('approvalRequests')
      .select(['id', 'workspaceId', 'userId', 'capability', 'expiresAt'])
      .where('status', '=', 'pending')
      .where('expiresAt', 'is not', null)
      .where('expiresAt', '<', now)
      .execute();
    for (const row of rows) {
      await db
        .updateTable('approvalRequests')
        .set({ status: 'expired', updatedAt: nowIso() })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .execute();
      await audit.log({
        workspaceId: row.workspaceId,
        userId: row.userId,
        eventType: 'approval.expired',
        actor: 'worker',
        capability: row.capability,
        targetType: 'approval_request',
        targetId: row.id,
        summary: `Approval for '${row.capability}' expired before a decision`,
        metadata: { expiresAt: row.expiresAt },
      });
    }
  }

  async function tick(): Promise<void> {
    try {
      await runScheduledDigests();
    } catch (err) {
      console.error('[worker] scheduled digest job failed', err);
    }
    try {
      await ingestion.syncDueAccounts({ triggeredBy: 'scheduled' });
    } catch (err) {
      console.error('[worker] scheduled connector sync failed', err);
    }
    try {
      await expireApprovals();
    } catch (err) {
      console.error('[worker] approval expiry failed', err);
    }
  }

  function start(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      void tick();
    }, tickMs);
    void tick();
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}
