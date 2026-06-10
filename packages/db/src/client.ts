import SQLite from 'better-sqlite3';
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { DB } from './schema.js';

export interface DbConfig {
  /** `postgres://...` for Postgres, otherwise a SQLite file path. */
  databaseUrl?: string;
  /** SQLite file path used when no databaseUrl is given. */
  sqlitePath?: string;
}

export type Db = Kysely<DB>;

export function isPostgresUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith('postgres://') || url.startsWith('postgresql://'));
}

/**
 * Create a Kysely instance. Defaults to local SQLite; set DATABASE_URL to a
 * postgres:// URL for cloud deployments. `:memory:` is supported for tests.
 */
export function createDb(config: DbConfig = {}): Db {
  const url = config.databaseUrl ?? process.env.DATABASE_URL;
  if (isPostgresUrl(url)) {
    return new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }),
      plugins: [new CamelCasePlugin()],
    });
  }
  const file = url ?? config.sqlitePath ?? process.env.DONNA_SQLITE_PATH ?? './data/donna.db';
  if (file !== ':memory:') {
    mkdirSync(dirname(resolve(file)), { recursive: true });
  }
  const sqlite = new SQLite(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new CamelCasePlugin()],
  });
}
