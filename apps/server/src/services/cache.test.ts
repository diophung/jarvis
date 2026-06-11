import { describe, expect, it } from 'vitest';
import { createSettingsService } from './settings.js';
import { cacheKey, createMemoryCache } from './cache.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import type { CacheService } from '../context.js';

describe('memory cache', () => {
  it('stores, expires, and evicts entries', async () => {
    let clock = 0;
    const cache = createMemoryCache({ maxEntries: 2, now: () => clock });
    await cache.set('a', { v: 1 }, 10);
    expect(await cache.get('a')).toEqual({ v: 1 });

    // TTL expiry.
    clock = 11_000;
    expect(await cache.get('a')).toBeUndefined();

    // Bounded size: oldest entry is evicted.
    clock = 0;
    await cache.set('x', 1, 60);
    await cache.set('y', 2, 60);
    await cache.set('z', 3, 60);
    expect(await cache.get('x')).toBeUndefined();
    expect(await cache.get('y')).toBe(2);
    expect(await cache.get('z')).toBe(3);
  });

  it('withCache loads once and serves hits afterwards', async () => {
    const cache = createMemoryCache();
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return 'value';
    };
    expect(await cache.withCache('k', 60, loader)).toBe('value');
    expect(await cache.withCache('k', 60, loader)).toBe('value');
    expect(loads).toBe(1);
    const stats = cache.stats();
    expect(stats.backend).toBe('memory');
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });

  it('del invalidates entries', async () => {
    const cache = createMemoryCache();
    await cache.set('k', 1, 60);
    await cache.del('k');
    expect(await cache.get('k')).toBeUndefined();
  });

  it('cacheKey is workspace-scoped (tenancy in every key)', () => {
    expect(cacheKey('wsp_a', 'setting', 'x')).toBe('ws:wsp_a:setting:x');
    expect(cacheKey('wsp_a', 'setting', 'x')).not.toBe(cacheKey('wsp_b', 'setting', 'x'));
  });
});

/** A cache whose backend always fails — the caller must fall through to the DB. */
function brokenCache(): CacheService {
  return {
    async get() {
      return undefined; // adapters fail open: errors surface as misses
    },
    async set() {},
    async del() {},
    async withCache(_key, _ttl, loader) {
      return loader();
    },
    stats: () => ({ backend: 'redis', hits: 0, misses: 0, errors: 1 }),
    async close() {},
  };
}

describe('settings with cache', () => {
  it('serves cached reads and invalidates on write', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const cache = createMemoryCache();
    const settings = createSettingsService({ db, cache });

    expect(await settings.get(workspaceId, 'k', 'fallback')).toBe('fallback');
    await settings.set(workspaceId, 'k', 'v1');
    expect(await settings.get(workspaceId, 'k', 'fallback')).toBe('v1');
    // Write-through invalidation: a new value is visible immediately.
    await settings.set(workspaceId, 'k', 'v2');
    expect(await settings.get(workspaceId, 'k', 'fallback')).toBe('v2');
    expect(cache.stats().hits + cache.stats().misses).toBeGreaterThan(0);
  });

  it('cached settings are workspace-scoped', async () => {
    const db = await createTestDb();
    const a = await seedWorkspace(db);
    const b = await seedWorkspace(db);
    const settings = createSettingsService({ db, cache: createMemoryCache() });
    await settings.set(a.workspaceId, 'style', 'concise');
    // Warm A's cache, then read B — must not see A's value.
    expect(await settings.get(a.workspaceId, 'style', 'none')).toBe('concise');
    expect(await settings.get(b.workspaceId, 'style', 'none')).toBe('none');
  });

  it('falls back to the database when the cache backend is broken', async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    const settings = createSettingsService({ db, cache: brokenCache() });
    await settings.set(workspaceId, 'k', 'durable');
    expect(await settings.get(workspaceId, 'k', 'fallback')).toBe('durable');
  });
});
