import { sql, type Kysely } from 'kysely';

/**
 * v1.1 — authentication + OAuth data-source authorization.
 *
 * Adds:
 *  - users: email_verified / avatar_url / last_login_at
 *  - auth_accounts: linked OAuth login identities (google/facebook/apple)
 *  - sessions: DB-backed login sessions (cookie token stored as sha256 hash)
 *  - oauth_tokens: per-source Google grants, tokens AES-256-GCM encrypted
 *  - source_accounts: last_error (connection-level errors surfaced in the UI)
 *
 * Same portable SQL subset as 0001 (TEXT/INTEGER, ISO timestamps, 0|1 bools).
 */
const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN avatar_url TEXT`,
  `ALTER TABLE users ADD COLUMN last_login_at TEXT`,
  `ALTER TABLE source_accounts ADD COLUMN last_error TEXT`,
  `CREATE TABLE IF NOT EXISTS auth_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    display_name TEXT,
    avatar_url TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, provider_account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_accounts_user ON auth_accounts (user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_account_id TEXT,
    provider_account_id TEXT,
    provider_email TEXT,
    granted_scopes TEXT NOT NULL DEFAULT '[]',
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    access_token_expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_refreshed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source_account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens (user_id, provider, source_type)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['oauth_tokens', 'sessions', 'auth_accounts']) {
    await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(db);
  }
}
