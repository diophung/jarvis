/**
 * Idempotency for unsafe write endpoints.
 *
 * Clients send an `Idempotency-Key` header on POST/PUT requests; the first
 * execution stores its response, and any retry with the same key (network
 * retry, double-click, at-least-once queue delivery) replays the stored
 * response instead of double-writing. A reused key with a *different*
 * request body is rejected (409), as is a concurrent in-flight duplicate.
 *
 * Records are tenant-scoped — (workspace, user, endpoint, key) — so keys
 * can never collide or leak across tenants. Expired records are purged by
 * the worker.
 */
import { newId, nowIso, toJson } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { createHash } from 'node:crypto';
import type { IdempotencyBegin, IdempotencyService } from '../context.js';

const DEFAULT_TTL_HOURS = 24;
const HOUR_MS = 3_600_000;

export function hashRequestBody(body: unknown): string {
  return createHash('sha256')
    .update(typeof body === 'string' ? body : JSON.stringify(body ?? null))
    .digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === '23505' || // postgres unique_violation
    (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) ||
    /unique constraint/i.test(e?.message ?? '')
  );
}

export function createIdempotencyService(deps: { db: Db }): IdempotencyService {
  const { db } = deps;

  async function readRecord(
    workspaceId: string,
    userId: string,
    endpoint: string,
    key: string,
  ) {
    return db
      .selectFrom('idempotencyKeys')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .where('endpoint', '=', endpoint)
      .where('key', '=', key)
      .executeTakeFirst();
  }

  function classify(
    record: NonNullable<Awaited<ReturnType<typeof readRecord>>>,
    requestHash: string,
  ): IdempotencyBegin {
    if (record.requestHash !== requestHash) return { kind: 'key_reuse_conflict' };
    if (record.status === 'completed' && record.responseStatus !== null) {
      return {
        kind: 'replay',
        responseStatus: record.responseStatus,
        responseBody: record.responseBody,
      };
    }
    return { kind: 'in_flight_conflict' };
  }

  const service: IdempotencyService = {
    async begin(workspaceId, userId, endpoint, key, requestHash, opts = {}) {
      const now = nowIso();
      const ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
      const id = newId('idk');

      try {
        await db
          .insertInto('idempotencyKeys')
          .values({
            id,
            workspaceId,
            userId,
            endpoint,
            key,
            requestHash,
            status: 'in_progress',
            responseStatus: null,
            responseBody: null,
            expiresAt: new Date(Date.parse(now) + ttlHours * HOUR_MS).toISOString(),
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Lost the insert race or the key already exists: classify the winner.
        const existing = await readRecord(workspaceId, userId, endpoint, key);
        if (existing === undefined) throw err; // raced with expiry cleanup; treat as conflict
        return classify(existing, requestHash);
      }

      return {
        kind: 'proceed',
        async complete(responseStatus, responseBody) {
          await db
            .updateTable('idempotencyKeys')
            .set({
              status: 'completed',
              responseStatus,
              responseBody: typeof responseBody === 'string' ? responseBody : toJson(responseBody),
              updatedAt: nowIso(),
            })
            .where('id', '=', id)
            .execute();
        },
        async abandon() {
          // A failed handler must not poison the key — let the client retry.
          await db.deleteFrom('idempotencyKeys').where('id', '=', id).execute();
        },
      };
    },

    async cleanupExpired() {
      const result = await db
        .deleteFrom('idempotencyKeys')
        .where('expiresAt', '<', nowIso())
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
  return service;
}
