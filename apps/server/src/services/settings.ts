import { fromJson, newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import type { SettingsService } from '../context.js';

export function createSettingsService(deps: { db: Db }): SettingsService {
  const { db } = deps;
  return {
    async get<T>(workspaceId: string, key: string, fallback: T): Promise<T> {
      const row = await db
        .selectFrom('appSettings')
        .select('value')
        .where('workspaceId', '=', workspaceId)
        .where('key', '=', key)
        .executeTakeFirst();
      if (!row) return fallback;
      return fromJson<T>(row.value, fallback);
    },

    async set(workspaceId: string, key: string, value: unknown): Promise<void> {
      const now = nowIso();
      const existing = await db
        .selectFrom('appSettings')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .where('key', '=', key)
        .executeTakeFirst();
      if (existing) {
        await db
          .updateTable('appSettings')
          .set({ value: toJson(value), updatedAt: now })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('appSettings')
          .values({ id: newId('set'), workspaceId, key, value: toJson(value), updatedAt: now })
          .execute();
      }
    },

    async getAll(workspaceId: string): Promise<Record<string, unknown>> {
      const rows = await db
        .selectFrom('appSettings')
        .select(['key', 'value'])
        .where('workspaceId', '=', workspaceId)
        .execute();
      const out: Record<string, unknown> = {};
      for (const r of rows) out[r.key] = fromJson<unknown>(r.value, null);
      return out;
    },
  };
}
