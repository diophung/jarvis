/** Donna API server entrypoint. */
import { createDefaultRegistry } from '@donna/connectors';
import { createDb, createDbMetrics, migrateToLatest } from '@donna/db';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { buildServices } from './services/index.js';
import { createWorkerLoop } from './worker-loop.js';

const config = loadConfig();
const dbMetrics = createDbMetrics({
  slowQueryMs: config.env.DONNA_DB_SLOW_QUERY_MS,
  onSlowQuery: (e) =>
    console.warn(`[db] slow query ${e.durationMs}ms (${e.operation}): ${e.sql}`),
});
const db = createDb({
  databaseUrl: config.env.DATABASE_URL,
  sqlitePath: config.sqlitePath,
  metrics: dbMetrics,
  pool: {
    size: config.env.DONNA_DB_POOL_SIZE,
    connectTimeoutMs: config.env.DONNA_DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: config.env.DONNA_DB_IDLE_TIMEOUT_MS,
    statementTimeoutMs: config.env.DONNA_DB_STATEMENT_TIMEOUT_MS,
  },
  applicationName: 'donna-api',
});
await migrateToLatest(db);

const connectors = createDefaultRegistry();
const services = await buildServices({ db, config, connectors });
const ctx: AppContext = { config, db, connectors, services, dbMetrics };

const boot = await bootstrap(db, config, services);
const app = await buildApp(ctx);

if (!config.isProdSecret) {
  app.log.warn(
    'DONNA_SECRET is using the development default — set a strong secret in production.',
  );
}
if (
  !config.env.DONNA_TOKEN_ENCRYPTION_KEY &&
  !config.isProdSecret &&
  (config.env.GOOGLE_CLIENT_ID || config.env.FACEBOOK_CLIENT_ID || config.env.APPLE_CLIENT_ID)
) {
  app.log.warn(
    'OAuth is configured but the token encryption key falls back to the development-default ' +
      'DONNA_SECRET — stored OAuth tokens are encrypted with a PUBLICLY KNOWN key. ' +
      'Set DONNA_TOKEN_ENCRYPTION_KEY (or a strong DONNA_SECRET) before going to production.',
  );
}
if (boot.seededDemo) {
  app.log.info('Demo workspace seeded (mock sources, people, projects).');
}

// Run the scheduler in-process unless a dedicated worker handles it
// (docker-compose sets DONNA_INLINE_WORKER=false on the API service).
const worker = config.env.DONNA_INLINE_WORKER ? createWorkerLoop(ctx) : null;
worker?.start();

const close = async () => {
  worker?.stop();
  await app.close();
  await services.cache.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

try {
  await app.listen({ port: config.env.DONNA_PORT, host: config.env.DONNA_HOST });
  app.log.info(`Donna is ready → http://localhost:${config.env.DONNA_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
