import { fromJson, newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import type { CacheService, SettingsService } from '../context.js';
import { cacheKey } from './cache.js';

/** Settings reads happen on nearly every request; cache briefly, invalidate on write. */
const SETTING_CACHE_TTL_SECONDS = 30;

/** Cached box: distinguishes "row absent" from "row present with null value". */
interface SettingBox {
  raw: string | null;
}

export function createSettingsService(deps: { db: Db; cache?: CacheService }): SettingsService {
  const { db, cache } = deps;

  async function readRaw(workspaceId: string, key: string): Promise<SettingBox> {
    const row = await db
      .selectFrom('appSettings')
      .select('value')
      .where('workspaceId', '=', workspaceId)
      .where('key', '=', key)
      .executeTakeFirst();
    return { raw: row?.value ?? null };
  }

  return {
    async get<T>(workspaceId: string, key: string, fallback: T): Promise<T> {
      const box =
        cache !== undefined
          ? await cache.withCache(
              cacheKey(workspaceId, 'setting', key),
              SETTING_CACHE_TTL_SECONDS,
              () => readRaw(workspaceId, key),
            )
          : await readRaw(workspaceId, key);
      if (box.raw === null) return fallback;
      return fromJson<T>(box.raw, fallback);
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
      // Write-through invalidation. (Multi-replica deployments additionally
      // rely on the short TTL; see production-database.md.)
      await cache?.del(cacheKey(workspaceId, 'setting', key));
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
