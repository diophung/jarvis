/**
 * Standalone worker entrypoint: scheduled digests, periodic incremental
 * connector syncs, approval expiry. Run alongside the API server when not
 * using the in-process worker (see DONNA_INLINE_WORKER).
 */
import { createDefaultRegistry } from '@donna/connectors';
import { createDb, migrateToLatest } from '@donna/db';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { buildServices } from './services/index.js';
import { createWorkerLoop } from './worker-loop.js';

const config = loadConfig();
const db = createDb({ databaseUrl: config.env.DATABASE_URL, sqlitePath: config.sqlitePath });
await migrateToLatest(db);

const connectors = createDefaultRegistry();
const services = buildServices({ db, config, connectors });
const ctx: AppContext = { config, db, connectors, services };

const loop = createWorkerLoop(ctx);
loop.start();
console.log('[worker] Donna worker running (digest schedule, syncs, approval expiry).');

const close = async () => {
  loop.stop();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
