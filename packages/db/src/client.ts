import SQLite from 'better-sqlite3';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, SqliteDialect } from 'kysely';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { DbMetrics } from './metrics.js';
import type { DB } from './schema.js';

export interface DbPoolConfig {
  /** Max connections in the Postgres pool. Default 10 (set per replica so replicas × size stays under the server limit). */
  size?: number;
  /** Fail a connection attempt after this long. Default 5000ms. */
  connectTimeoutMs?: number;
  /** Recycle idle connections after this long. Default 30000ms. */
  idleTimeoutMs?: number;
  /** Server-side statement timeout — no query may run longer. Default 10000ms. */
  statementTimeoutMs?: number;
}

export interface DbConfig {
  /** `postgres://...` for Postgres, otherwise a SQLite file path. */
  databaseUrl?: string;
  /** SQLite file path used when no databaseUrl is given. */
  sqlitePath?: string;
  pool?: DbPoolConfig;
  /** Query observability sink (latency, errors, slow queries). */
  metrics?: DbMetrics;
  /** Identifies this process in pg_stat_activity. Default 'jarvis'. */
  applicationName?: string;
}

export type Db = Kysely<DB>;

export type DbDialectName = 'postgres' | 'sqlite';

export interface DbPoolStats {
  /** Connections currently open. */
  total: number;
  idle: number;
  /** Queued requests waiting for a free connection — sustained > 0 means the pool is saturated. */
  waiting: number;
  max: number;
}

export interface DbRuntime {
  dialect: DbDialectName;
  /** Live pool statistics (Postgres only; SQLite reports a single embedded connection). */
  poolStats(): DbPoolStats;
}

/** Runtime info (dialect, pool stats) per Kysely instance, without changing the Db type. */
const runtimes = new WeakMap<Kysely<DB>, DbRuntime>();

export function isPostgresUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith('postgres://') || url.startsWith('postgresql://'));
}

/** Dialect and pool stats for a Db created by createDb(). */
export function getDbRuntime(db: Db): DbRuntime {
  const runtime = runtimes.get(db);
  if (runtime === undefined) {
    return { dialect: 'sqlite', poolStats: () => ({ total: 1, idle: 1, waiting: 0, max: 1 }) };
  }
  return runtime;
}

function makeLogHook(metrics: DbMetrics | undefined) {
  if (metrics === undefined) return undefined;
  return (event: {
    level: 'query' | 'error';
    query: { sql: string };
    queryDurationMillis: number;
  }): void => {
    metrics.observeQuery(event.query.sql, event.queryDurationMillis, event.level === 'error');
  };
}

/**
 * Create a Kysely instance. Defaults to local SQLite; set DATABASE_URL to a
 * postgres:// URL for cloud deployments (Aurora/AlloyDB/Cloud SQL/Neon all
 * speak this). `:memory:` is supported for tests.
 *
 * Production hardening applied here:
 *  - bounded connection pool with connect/idle timeouts
 *  - server-side statement_timeout (no unbounded queries)
 *  - query metrics + slow-query observability via the Kysely log hook
 *  - pg pool 'error' handler so idle-connection failures never crash the process
 */
export function createDb(config: DbConfig = {}): Db {
  const url = config.databaseUrl ?? process.env.DATABASE_URL;
  const log = makeLogHook(config.metrics);

  if (isPostgresUrl(url)) {
    const poolCfg = config.pool ?? {};
    const pool = new pg.Pool({
      connectionString: url,
      max: poolCfg.size ?? 10,
      connectionTimeoutMillis: poolCfg.connectTimeoutMs ?? 5_000,
      idleTimeoutMillis: poolCfg.idleTimeoutMs ?? 30_000,
      statement_timeout: poolCfg.statementTimeoutMs ?? 10_000,
      application_name: config.applicationName ?? 'jarvis',
    });
    // An idle client losing its connection (failover, LB rotation) emits
    // 'error' on the pool; without a handler that is a process crash.
    pool.on('error', (err) => {
      console.error('[db] idle postgres connection error (pool will replace it):', err.message);
    });
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()],
      ...(log !== undefined ? { log } : {}),
    });
    runtimes.set(db, {
      dialect: 'postgres',
      poolStats: () => ({
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: poolCfg.size ?? 10,
      }),
    });
    return db;
  }

  const file = url ?? config.sqlitePath ?? process.env.JARVIS_SQLITE_PATH ?? './data/jarvis.db';
  if (file !== ':memory:') {
    mkdirSync(dirname(resolve(file)), { recursive: true });
  }
  const sqlite = new SQLite(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Wait for concurrent writers (API + worker share the file) instead of
  // failing immediately with SQLITE_BUSY.
  sqlite.pragma('busy_timeout = 5000');
  const db = new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new CamelCasePlugin()],
    ...(log !== undefined ? { log } : {}),
  });
  runtimes.set(db, {
    dialect: 'sqlite',
    poolStats: () => ({ total: 1, idle: 1, waiting: 0, max: 1 }),
  });
  return db;
}

export interface DbHealth {
  ok: boolean;
  dialect: DbDialectName;
  latencyMs: number;
  pool: DbPoolStats;
  error?: string;
}

/**
 * Liveness probe for the database: a `SELECT 1` round-trip with its own
 * deadline so a hung pool cannot hang the health endpoint.
 */
export async function checkDbHealth(db: Db, timeoutMs = 2_000): Promise<DbHealth> {
  const runtime = getDbRuntime(db);
  const started = Date.now();
  try {
    await Promise.race([
      sql`select 1 as ok`.execute(db),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return {
      ok: true,
      dialect: runtime.dialect,
      latencyMs: Date.now() - started,
      pool: runtime.poolStats(),
    };
  } catch (err) {
    return {
      ok: false,
      dialect: runtime.dialect,
      latencyMs: Date.now() - started,
      pool: runtime.poolStats(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
