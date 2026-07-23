/**
 * Privacy operations: full account data export and durable "delete all my
 * data" requests.
 *
 * Deletion is a tracked, auditable job (data_deletion_requests) processed by
 * the worker: requesting is instant and idempotent; the purge itself runs
 * with per-table accounting so a crash mid-purge resumes safely (every
 * delete is workspace-scoped and re-runnable). Uploaded blobs are removed
 * from object storage best-effort before their rows go.
 *
 * What is kept after a purge: the user/workspace identity rows, login
 * sessions, and audit_logs (the legal/audit record of what happened —
 * including the deletion itself). Everything content-bearing goes.
 */
import { fromJson, newId, nowIso, toJson } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import type {
  AuditService,
  PrivacyService,
  StorageService,
  VectorStore,
} from '../context.js';
import { conflict } from '../lib/http-errors.js';

/** Content tables purged on deletion, in child-before-parent order. */
const PURGE_TABLES = [
  'embeddingRecords',
  'retrievalChunks',
  'digestItems',
  'digests',
  'messages',
  'conversations',
  'itemFeedback',
  'taskCandidates',
  'learningSignals',
  'learnedPreferences',
  'memoryEntries',
  'userPreferences',
  'sourceAttachments',
  'sourceItems',
  'connectorRuns',
  'uploadedFiles',
  'agentActions',
  'approvalRequests',
  'permissionPolicies',
  'people',
  'organizations',
  'projects',
  'oauthTokens',
  'sourceAccounts',
  'llmCallLogs',
  'llmTaskRoutes',
  'llmProviderConfigs',
  'idempotencyKeys',
  'appSettings',
] as const;

/** Tables included in a data export (everything purgeable + the audit log). */
const EXPORT_TABLES = [...PURGE_TABLES, 'auditLogs'] as const;

const EXPORT_ROW_CAP = 10_000;
const DELETE_BATCH = 1_000;

export function createPrivacyService(deps: {
  db: Db;
  audit: AuditService;
  storage: StorageService;
  vectors: VectorStore;
}): PrivacyService {
  const { db, audit, storage, vectors } = deps;

  const service: PrivacyService = {
    async exportAccountData(workspaceId, userId) {
      const tables: Record<string, { rows: unknown[]; truncated: boolean }> = {};
      for (const table of EXPORT_TABLES) {
        const rows = await db
          .selectFrom(table)
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .limit(EXPORT_ROW_CAP + 1)
          .execute();
        tables[table] = {
          rows: rows.slice(0, EXPORT_ROW_CAP),
          truncated: rows.length > EXPORT_ROW_CAP,
        };
      }
      const user = await db
        .selectFrom('users')
        .select(['id', 'email', 'name', 'role', 'createdAt'])
        .where('id', '=', userId)
        .executeTakeFirst();
      await audit.log({
        workspaceId,
        userId,
        eventType: 'privacy.export',
        actor: 'user',
        summary: 'Account data export generated',
        metadata: { tables: Object.keys(tables).length },
      });
      return { exportedAt: nowIso(), user: user ?? null, tables };
    },

    async requestDeletion(workspaceId, userId) {
      const existing = await db
        .selectFrom('dataDeletionRequests')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('status', 'in', ['pending', 'running'])
        .executeTakeFirst();
      if (existing !== undefined) {
        throw conflict('A deletion request is already in progress for this workspace');
      }
      const now = nowIso();
      const id = newId('del');
      await db
        .insertInto('dataDeletionRequests')
        .values({
          id,
          workspaceId,
          userId,
          requestedBy: userId,
          scope: 'workspace',
          status: 'pending',
          tablesPurged: '{}',
          error: null,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      await audit.log({
        workspaceId,
        userId,
        eventType: 'privacy.deletion.requested',
        actor: 'user',
        targetType: 'data_deletion_request',
        targetId: id,
        summary: 'Workspace data deletion requested',
        metadata: { scope: 'workspace' },
      });
      return service.getDeletionStatus(workspaceId).then((r) => {
        if (r === null) throw new Error('deletion request missing after insert');
        return r;
      });
    },

    async getDeletionStatus(workspaceId) {
      const row = await db
        .selectFrom('dataDeletionRequests')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .orderBy('requestedAt', 'desc')
        .executeTakeFirst();
      if (row === undefined) return null;
      return { ...row, tablesPurged: fromJson<Record<string, number>>(row.tablesPurged, {}) };
    },

    async processPending() {
      const pending = await db
        .selectFrom('dataDeletionRequests')
        .selectAll()
        .where('status', '=', 'pending')
        .orderBy('requestedAt', 'asc')
        .execute();

      let processed = 0;
      for (const request of pending) {
        // Claim guard: only one worker may move pending -> running.
        const claimed = await db
          .updateTable('dataDeletionRequests')
          .set({ status: 'running', startedAt: nowIso(), updatedAt: nowIso() })
          .where('id', '=', request.id)
          .where('status', '=', 'pending')
          .executeTakeFirst();
        if (Number(claimed.numUpdatedRows ?? 0) === 0) continue;

        try {
          const purged = await purgeWorkspace(request.workspaceId);
          await db
            .updateTable('dataDeletionRequests')
            .set({
              status: 'completed',
              tablesPurged: toJson(purged),
              completedAt: nowIso(),
              updatedAt: nowIso(),
            })
            .where('id', '=', request.id)
            .execute();
          await audit.log({
            workspaceId: request.workspaceId,
            userId: request.userId,
            eventType: 'privacy.deletion.completed',
            actor: 'worker',
            targetType: 'data_deletion_request',
            targetId: request.id,
            summary: `Workspace data purged (${Object.values(purged).reduce((a, b) => a + b, 0)} rows)`,
            metadata: { tables: Object.keys(purged).length },
          });
          processed += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await db
            .updateTable('dataDeletionRequests')
            .set({ status: 'failed', error: message, updatedAt: nowIso() })
            .where('id', '=', request.id)
            .execute();
          await audit.log({
            workspaceId: request.workspaceId,
            userId: request.userId,
            eventType: 'privacy.deletion.failed',
            actor: 'worker',
            targetType: 'data_deletion_request',
            targetId: request.id,
            summary: 'Workspace data deletion failed',
            metadata: { error: message.slice(0, 200) },
          });
        }
      }
      return { processed };
    },
  };

  async function purgeWorkspace(workspaceId: string): Promise<Record<string, number>> {
    const purged: Record<string, number> = {};

    // Uploaded blobs first (best-effort: a missing file must not block the purge).
    const uploads = await db
      .selectFrom('uploadedFiles')
      .select(['storagePath'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    for (const upload of uploads) {
      await storage.remove(upload.storagePath).catch(() => {});
    }

    // Vector side store (pgvector table is keyed by chunk id, not workspace).
    const chunkIds = (
      await db
        .selectFrom('retrievalChunks')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .execute()
    ).map((r) => r.id);
    for (let i = 0; i < chunkIds.length; i += DELETE_BATCH) {
      await vectors.removeByChunkIds(chunkIds.slice(i, i + DELETE_BATCH));
    }

    for (const table of PURGE_TABLES) {
      const result = await db
        .deleteFrom(table)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      const count = Number(result.numDeletedRows ?? 0);
      if (count > 0) purged[table] = count;
    }
    return purged;
  }

  return service;
}
