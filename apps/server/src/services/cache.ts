/**
 * Cache layer for hot reads (settings, preference lookups, briefing state).
 *
 * Two adapters behind one interface:
 *  - memory (default): per-process bounded map with TTL — zero config local path.
 *  - redis: shared cache when DONNA_REDIS_URL is set (ElastiCache/Valkey/
 *    Memorystore/Upstash compatible), wrapped in a circuit breaker.
 *
 * The cache is strictly disposable: every operation fails OPEN. A cache/
 * backend failure is recorded as a miss (or a no-op for writes) and the
 * caller falls through to the database — Redis is never a source of truth
 * and never on the error path.
 */
import { CircuitBreaker, CircuitOpenError } from '@donna/db';
import { Redis } from 'ioredis';
import type { CacheService, CacheStats } from '../context.js';

const MEMORY_MAX_ENTRIES = 10_000;

interface MemoryEntryBox {
  value: unknown;
  expiresAt: number;
}

class StatsCounter {
  hits = 0;
  misses = 0;
  errors = 0;

  snapshot(backend: CacheStats['backend'], breakerState?: string): CacheStats {
    const stats: CacheStats = {
      backend,
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
    };
    if (breakerState !== undefined) stats.breakerState = breakerState;
    return stats;
  }
}

/** Per-process bounded TTL cache. Oldest entries are evicted past the cap. */
export function createMemoryCache(opts: { maxEntries?: number; now?: () => number } = {}): CacheService {
  const maxEntries = opts.maxEntries ?? MEMORY_MAX_ENTRIES;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, MemoryEntryBox>();
  const stats = new StatsCounter();

  const service: CacheService = {
    async get<T>(key: string): Promise<T | undefined> {
      const box = entries.get(key);
      if (box === undefined || box.expiresAt <= now()) {
        if (box !== undefined) entries.delete(key);
        stats.misses += 1;
        return undefined;
      }
      // Refresh recency so hot keys survive eviction (Map preserves insertion order).
      entries.delete(key);
      entries.set(key, box);
      stats.hits += 1;
      return box.value as T;
    },

    async set(key, value, ttlSeconds) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    async del(...keys) {
      for (const key of keys) entries.delete(key);
    },

    async withCache(key, ttlSeconds, loader) {
      const cached = await service.get(key);
      if (cached !== undefined) return cached as Awaited<ReturnType<typeof loader>>;
      const value = await loader();
      if (value !== undefined) await service.set(key, value, ttlSeconds);
      return value;
    },

    stats: () => stats.snapshot('memory'),
    async close() {
      entries.clear();
    },
  };
  return service;
}

/**
 * Redis adapter. All calls run through a circuit breaker with short
 * timeouts; when Redis is down the breaker opens and every operation
 * degrades to a miss/no-op instantly instead of stalling request paths.
 */
export function createRedisCache(opts: {
  url: string;
  keyPrefix?: string;
  commandTimeoutMs?: number;
}): CacheService {
  const redis = new Redis(opts.url, {
    keyPrefix: opts.keyPrefix ?? 'donna:',
    commandTimeout: opts.commandTimeoutMs ?? 250,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', () => {
    // Connection errors surface per-command (and trip the breaker); without
    // this handler ioredis emits an unhandled 'error' event.
  });
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 15_000 });
  const stats = new StatsCounter();

  async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await breaker.exec(fn);
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) stats.errors += 1;
      return undefined;
    }
  }

  const service: CacheService = {
    async get<T>(key: string): Promise<T | undefined> {
      const raw = await guarded(() => redis.get(key));
      if (raw === undefined || raw === null) {
        stats.misses += 1;
        return undefined;
      }
      try {
        stats.hits += 1;
        return JSON.parse(raw) as T;
      } catch {
        stats.misses += 1;
        return undefined;
      }
    },

    async set(key, value, ttlSeconds) {
      await guarded(() => redis.set(key, JSON.stringify(value), 'EX', ttlSeconds));
    },

    async del(...keys) {
      if (keys.length === 0) return;
      await guarded(() => redis.del(...keys));
    },

    async withCache(key, ttlSeconds, loader) {
      const cached = await service.get(key);
      if (cached !== undefined) return cached as Awaited<ReturnType<typeof loader>>;
      const value = await loader();
      if (value !== undefined) await service.set(key, value, ttlSeconds);
      return value;
    },

    stats: () => stats.snapshot('redis', breaker.state),
    async close() {
      redis.disconnect();
    },
  };
  return service;
}

/** Pick the cache backend from configuration. */
export function createCacheService(opts: { redisUrl?: string }): CacheService {
  if (opts.redisUrl !== undefined && opts.redisUrl !== '') {
    return createRedisCache({ url: opts.redisUrl });
  }
  return createMemoryCache();
}

/** Workspace-scoped cache key helper — tenancy is part of every key. */
export function cacheKey(workspaceId: string, ...parts: string[]): string {
  return ['ws', workspaceId, ...parts].join(':');
}
