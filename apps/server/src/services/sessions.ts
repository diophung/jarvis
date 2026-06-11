import { newId, nowIso, type SessionRecord } from '@donna/core';
import type { Db } from '@donna/db';
import { randomToken, sha256Base64Url } from '../lib/oauth.js';

/**
 * DB-backed login sessions. The cookie carries an opaque random token; only
 * its sha256 hash is stored, so a database leak cannot be replayed as a
 * session. Sessions slide: activity refreshes last_seen_at and extends the
 * expiry once less than half the TTL remains.
 */

export const SESSION_TTL_DAYS = 30;
const TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Throttle last_seen_at writes to at most one per minute per session. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface SessionsService {
  /** Create a session and return the raw cookie token (never stored). */
  create(userId: string, workspaceId: string, meta?: SessionMeta): Promise<{ token: string; session: SessionRecord }>;
  /** Resolve a cookie token to a live session (sliding renewal), or null. */
  validate(token: string): Promise<SessionRecord | null>;
  /** Revoke one session owned by userId. Returns true when a row was deleted. */
  revoke(sessionId: string, userId: string): Promise<boolean>;
  /** Revoke all of a user's sessions except (optionally) the current one. */
  revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number>;
  listForUser(userId: string): Promise<SessionRecord[]>;
  /** Garbage-collect expired sessions (called from the worker loop). */
  deleteExpired(): Promise<number>;
}

export function createSessionsService(db: Db): SessionsService {
  return {
    async create(userId, workspaceId, meta = {}) {
      const token = randomToken(32);
      const now = nowIso();
      const session: SessionRecord = {
        id: newId('ses'),
        userId,
        workspaceId,
        tokenHash: sha256Base64Url(token),
        expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        lastSeenAt: now,
        userAgent: meta.userAgent ? String(meta.userAgent).slice(0, 256) : null,
        ip: meta.ip ? String(meta.ip).slice(0, 64) : null,
        createdAt: now,
      };
      await db.insertInto('sessions').values(session).execute();
      return { token, session };
    },

    async validate(token) {
      if (!token || token.length < 16 || token.length > 128) return null;
      const row = await db
        .selectFrom('sessions')
        .selectAll()
        .where('tokenHash', '=', sha256Base64Url(token))
        .executeTakeFirst();
      if (!row) return null;
      const nowMs = Date.now();
      const expiresMs = Date.parse(row.expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
        await db.deleteFrom('sessions').where('id', '=', row.id).execute();
        return null;
      }
      const patch: Record<string, string> = {};
      if (nowMs - Date.parse(row.lastSeenAt) > TOUCH_INTERVAL_MS) patch.lastSeenAt = nowIso();
      if (expiresMs - nowMs < TTL_MS / 2) patch.expiresAt = new Date(nowMs + TTL_MS).toISOString();
      if (Object.keys(patch).length > 0) {
        await db.updateTable('sessions').set(patch).where('id', '=', row.id).execute();
        Object.assign(row, patch);
      }
      return row as SessionRecord;
    },

    async revoke(sessionId, userId) {
      const result = await db
        .deleteFrom('sessions')
        .where('id', '=', sessionId)
        .where('userId', '=', userId)
        .executeTakeFirst();
      return Number(result?.numDeletedRows ?? 0) > 0;
    },

    async revokeAllForUser(userId, exceptSessionId) {
      let query = db.deleteFrom('sessions').where('userId', '=', userId);
      if (exceptSessionId) query = query.where('id', '!=', exceptSessionId);
      const result = await query.executeTakeFirst();
      return Number(result?.numDeletedRows ?? 0);
    },

    async listForUser(userId) {
      const rows = await db
        .selectFrom('sessions')
        .selectAll()
        .where('userId', '=', userId)
        .orderBy('lastSeenAt', 'desc')
        .execute();
      return rows as SessionRecord[];
    },

    async deleteExpired() {
      const result = await db
        .deleteFrom('sessions')
        .where('expiresAt', '<', nowIso())
        .executeTakeFirst();
      return Number(result?.numDeletedRows ?? 0);
    },
  };
}
