/** Run DB migrations and exit. Usage: pnpm --filter @jarvis/server db:migrate */
import { createDb, migrateToLatest } from '@jarvis/db';
import { loadConfig } from '../config.js';

const config = loadConfig();
const db = createDb({ databaseUrl: config.env.DATABASE_URL, sqlitePath: config.sqlitePath });
try {
  await migrateToLatest(db);
  console.log('Migrations applied.');
} finally {
  await db.destroy();
}
