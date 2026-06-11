import { describe, expect, it, vi } from 'vitest';
import { checkDbHealth, createDb, getDbRuntime } from './client.js';
import { classifyQuery, createDbMetrics } from './metrics.js';
import { migrateToLatest } from './migrate.js';

describe('classifyQuery', () => {
  it('buckets queries by operation and table with low cardinality', () => {
    expect(classifyQuery('select * from "source_items" where id = $1')).toBe('select source_items');
    expect(classifyQuery('insert into "learning_signals" (id) values ($1)')).toBe(
      'insert learning_signals',
    );
    expect(classifyQuery('update users set name = $1')).toBe('update users');
    expect(classifyQuery('BEGIN')).toBe('begin');
  });
});

describe('createDbMetrics', () => {
  it('aggregates counts, errors, latency percentiles, and per-operation stats', () => {
    const metrics = createDbMetrics({ slowQueryMs: 100 });
    for (let i = 1; i <= 100; i += 1) {
      metrics.observeQuery('select * from users', i, false);
    }
    metrics.observeQuery('insert into users (id) values ($1)', 5, true);

    const snap = metrics.snapshot();
    expect(snap.totalQueries).toBe(101);
    expect(snap.totalErrors).toBe(1);
    expect(snap.latencyMs.p50).toBeGreaterThanOrEqual(45);
    expect(snap.latencyMs.p95).toBeGreaterThanOrEqual(90);
    expect(snap.latencyMs.max).toBe(100);
    expect(snap.byOperation['select users']?.count).toBe(100);
    expect(snap.byOperation['insert users']?.errors).toBe(1);
  });

  it('flags slow queries and emits PII-safe slow-query events', () => {
    const onSlowQuery = vi.fn();
    const metrics = createDbMetrics({ slowQueryMs: 50, onSlowQuery });
    metrics.observeQuery('select * from "messages" where workspace_id = $1', 80, false);
    metrics.observeQuery('select 1', 10, false);

    expect(metrics.snapshot().slowQueries).toBe(1);
    expect(onSlowQuery).toHaveBeenCalledTimes(1);
    const event = onSlowQuery.mock.calls[0]![0];
    // Parameterized SQL only — never values.
    expect(event.sql).toContain('$1');
    expect(event.durationMs).toBe(80);
  });

  it('counts retries', () => {
    const metrics = createDbMetrics();
    metrics.observeRetry();
    metrics.observeRetry();
    expect(metrics.snapshot().retries).toBe(2);
  });
});

describe('createDb instrumentation + health', () => {
  it('records query metrics through the Kysely log hook', async () => {
    const metrics = createDbMetrics();
    const db = createDb({ sqlitePath: ':memory:', metrics });
    await migrateToLatest(db);
    await db.selectFrom('users').selectAll().execute();
    const snap = metrics.snapshot();
    expect(snap.totalQueries).toBeGreaterThan(0);
    expect(Object.keys(snap.byOperation).some((k) => k.startsWith('select'))).toBe(true);
    await db.destroy();
  });

  it('reports dialect and pool stats via getDbRuntime', async () => {
    const db = createDb({ sqlitePath: ':memory:' });
    const runtime = getDbRuntime(db);
    expect(runtime.dialect).toBe('sqlite');
    expect(runtime.poolStats().max).toBe(1);
    await db.destroy();
  });

  it('checkDbHealth succeeds on a live db and fails cleanly on a destroyed one', async () => {
    const db = createDb({ sqlitePath: ':memory:' });
    const healthy = await checkDbHealth(db);
    expect(healthy.ok).toBe(true);
    expect(healthy.dialect).toBe('sqlite');
    expect(healthy.latencyMs).toBeGreaterThanOrEqual(0);

    await db.destroy();
    const unhealthy = await checkDbHealth(db, 500);
    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.error).toBeTruthy();
  });
});
