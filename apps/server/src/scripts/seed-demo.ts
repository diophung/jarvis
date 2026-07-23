/** Force-seed the demo workspace. Usage: pnpm --filter @jarvis/server seed:demo */
import { createDefaultRegistry } from '@jarvis/connectors';
import { createDb, migrateToLatest } from '@jarvis/db';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { buildServices } from '../services/index.js';

const config = loadConfig({ JARVIS_DEMO_SEED: 'true' });
const db = createDb({ databaseUrl: config.env.DATABASE_URL, sqlitePath: config.sqlitePath });
await migrateToLatest(db);
const services = await buildServices({ db, config, connectors: createDefaultRegistry() });
const result = await bootstrap(db, config, services);
console.log(
  result.seededDemo
    ? 'Demo workspace seeded.'
    : 'Demo data already present (or sources already connected) — nothing to do.',
);
await db.destroy();
