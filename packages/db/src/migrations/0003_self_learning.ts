import { sql, type Kysely } from 'kysely';

/**
 * v1.2 — self-learning subsystem.
 *
 * Adds:
 *  - learning_signals: append-only normalized learning observations with
 *    full provenance (source type/ref, observation time). `processed`
 *    flips when the inference engine consumes a signal.
 *  - learned_preferences: inspectable, correctable, decaying preferences
 *    aggregated from signals. `scope_key` is the canonical serialization of
 *    the scope JSON, making (workspace, user, key, scope) addressable.
 *
 * Same portable SQL subset as 0001 (TEXT/INTEGER/REAL, ISO timestamps,
 * 0|1 bools, JSON as TEXT).
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS learning_signals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    strength REAL NOT NULL,
    scope TEXT NOT NULL DEFAULT '{}',
    detail TEXT,
    source TEXT NOT NULL DEFAULT '{}',
    observed_at TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_learning_signals_ws_processed ON learning_signals (workspace_id, processed)`,
  `CREATE INDEX IF NOT EXISTS idx_learning_signals_ws_key ON learning_signals (workspace_id, key)`,
  `CREATE TABLE IF NOT EXISTS learned_preferences (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    statement TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '{}',
    scope_key TEXT NOT NULL DEFAULT 'global',
    origin TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    confidence REAL NOT NULL,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    evidence_weight REAL NOT NULL DEFAULT 0,
    contradiction_count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    decay_half_life_days INTEGER NOT NULL DEFAULT 90,
    last_reinforced_at TEXT NOT NULL,
    explanation TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    contradictions TEXT NOT NULL DEFAULT '[]',
    user_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, user_id, key, scope_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_learned_preferences_ws_user ON learned_preferences (workspace_id, user_id, status)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['learned_preferences', 'learning_signals']) {
    await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(db);
  }
}
