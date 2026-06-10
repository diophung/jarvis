import { fromJson, newId, nowIso, toJson, type AuditLog } from '@donna/core';
import type { Db } from '@donna/db';
import type { AuditEntryInput, AuditService } from '../context.js';

const SECRET_KEY_PATTERN = /key|token|secret|password|credential|authorization/i;
const MAX_STRING = 500;

/** Strip secret-looking keys and truncate long strings before persisting. */
export function redactMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = '[redacted]';
    } else if (typeof v === 'string') {
      out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…[truncated]` : v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactMetadata(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createAuditService(deps: { db: Db }): AuditService {
  const { db } = deps;
  return {
    async log(entry: AuditEntryInput): Promise<void> {
      await db
        .insertInto('auditLogs')
        .values({
          id: newId('aud'),
          workspaceId: entry.workspaceId,
          userId: entry.userId ?? null,
          eventType: entry.eventType,
          actor: entry.actor,
          capability: entry.capability ?? null,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          summary: entry.summary.slice(0, MAX_STRING),
          metadata: toJson(redactMetadata(entry.metadata ?? {})),
          createdAt: nowIso(),
        })
        .execute();
    },

    async list(workspaceId, opts = {}) {
      let q = db
        .selectFrom('auditLogs')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .orderBy('createdAt', 'desc')
        .limit(Math.min(opts.limit ?? 100, 500));
      if (opts.before) q = q.where('createdAt', '<', opts.before);
      if (opts.eventType) q = q.where('eventType', '=', opts.eventType);
      if (opts.actor) q = q.where('actor', '=', opts.actor);
      const rows = await q.execute();
      return rows.map(
        (r): AuditLog => ({
          ...r,
          eventType: r.eventType as AuditLog['eventType'],
          actor: r.actor as AuditLog['actor'],
          metadata: fromJson<Record<string, unknown>>(r.metadata, {}),
        }),
      );
    },
  };
}
