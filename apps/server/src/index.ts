/** Donna API server entrypoint. */
import { createDefaultRegistry } from '@donna/connectors';
import { createDb, migrateToLatest } from '@donna/db';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';
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
