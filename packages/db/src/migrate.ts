import { Migrator, type Kysely, type Migration, type MigrationProvider } from 'kysely';
import * as m0001 from './migrations/0001_init.js';
import * as m0002 from './migrations/0002_auth_oauth.js';
import * as m0003 from './migrations/0003_self_learning.js';

/**
 * Static migration provider: migrations are imported directly so the runner
 * works identically under tsx, vitest, and bundled builds (no FS scanning).
 */
const migrations: Record<string, Migration> = {
  '0001_init': m0001,
  '0002_auth_oauth': m0002,
  '0003_self_learning': m0003,
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find((r) => r.status === 'Error');
    throw new Error(
      `Migration failed${failed ? ` at ${failed.migrationName}` : ''}: ${String(error)}`,
    );
  }
}
