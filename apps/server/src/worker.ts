/**
 * Standalone worker entrypoint: scheduled digests, periodic incremental
 * connector syncs, approval expiry. Run alongside the API server when not
 * using the in-process worker (see JARVIS_INLINE_WORKER).
 */
import { createDefaultRegistry } from '@jarvis/connectors';
import { createDb, createDbMetrics, migrateToLatest } from '@jarvis/db';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { buildServices } from './services/index.js';
import { createWorkerLoop } from './worker-loop.js';

const config = loadConfig();
const dbMetrics = createDbMetrics({
  slowQueryMs: config.env.JARVIS_DB_SLOW_QUERY_MS,
  onSlowQuery: (e) =>
    console.warn(`[db] slow query ${e.durationMs}ms (${e.operation}): ${e.sql}`),
});
const db = createDb({
  databaseUrl: config.env.DATABASE_URL,
  sqlitePath: config.sqlitePath,
  metrics: dbMetrics,
  pool: {
    size: config.env.JARVIS_DB_POOL_SIZE,
    connectTimeoutMs: config.env.JARVIS_DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: config.env.JARVIS_DB_IDLE_TIMEOUT_MS,
    statementTimeoutMs: config.env.JARVIS_DB_STATEMENT_TIMEOUT_MS,
  },
  applicationName: 'jarvis-worker',
});
await migrateToLatest(db);

const connectors = createDefaultRegistry();
const services = await buildServices({ db, config, connectors });
const ctx: AppContext = { config, db, connectors, services };

const loop = createWorkerLoop(ctx);
loop.start();
console.log('[worker] Jarvis worker running (digest schedule, syncs, approval expiry).');

const close = async () => {
  loop.stop();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
