import { sql, type Kysely } from 'kysely';

/**
 * v1.3 — production persistence operations.
 *
 * Adds:
 *  - idempotency_keys: replay protection for unsafe write endpoints. A row
 *    is keyed by (workspace, user, endpoint, key); completed rows store the
 *    response for replay; expired rows are garbage-collected by the worker.
 *  - data_deletion_requests: durable, auditable account-data deletion jobs
 *    (GDPR-style "delete all my data"), processed by the worker.
 *  - Hot-path composite indexes that were missing for production query
 *    patterns (preference lookups, embedding joins, approval expiry scans,
 *    task upserts, signal pruning).
 *
 * Same portable SQL subset as 0001 (TEXT/INTEGER/REAL, ISO timestamps,
 * 0|1 bools, JSON as TEXT). Everything here is additive — `down` only drops
 * what `up` created.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress',
    response_status INTEGER,
    response_body TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, user_id, endpoint, key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at)`,
  `CREATE TABLE IF NOT EXISTS data_deletion_requests (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'workspace',
    status TEXT NOT NULL DEFAULT 'pending',
    tables_purged TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deletion_requests_status ON data_deletion_requests (status, requested_at)`,
  // ---- missing hot-path indexes ----
  // Preference lookups: settings/preferences are read per (workspace, user) on
  // nearly every request.
  `CREATE INDEX IF NOT EXISTS idx_user_preferences_ws_user ON user_preferences (workspace_id, user_id)`,
  // Semantic search joins embedding_records -> retrieval_chunks filtered by
  // (workspace, model) ordered by recency.
  `CREATE INDEX IF NOT EXISTS idx_embeddings_ws_model_created ON embedding_records (workspace_id, model, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON embedding_records (chunk_id)`,
  // Worker approval-expiry scan is cross-workspace by (status, expires_at).
  `CREATE INDEX IF NOT EXISTS idx_approvals_status_expires ON approval_requests (status, expires_at)`,
  // Rescore upserts task_candidates by (workspace, source_item).
  `CREATE INDEX IF NOT EXISTS idx_task_candidates_ws_item ON task_candidates (workspace_id, source_item_id)`,
  // Learning-signal pruning and recency-weighted reads scan by observed_at.
  `CREATE INDEX IF NOT EXISTS idx_learning_signals_ws_observed ON learning_signals (workspace_id, observed_at)`,
  // Per-workspace message sweeps (export / deletion).
  `CREATE INDEX IF NOT EXISTS idx_messages_ws ON messages (workspace_id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const statement of [
    `DROP TABLE IF EXISTS idempotency_keys`,
    `DROP TABLE IF EXISTS data_deletion_requests`,
    `DROP INDEX IF EXISTS idx_user_preferences_ws_user`,
    `DROP INDEX IF EXISTS idx_embeddings_ws_model_created`,
    `DROP INDEX IF EXISTS idx_embeddings_chunk`,
    `DROP INDEX IF EXISTS idx_approvals_status_expires`,
    `DROP INDEX IF EXISTS idx_task_candidates_ws_item`,
    `DROP INDEX IF EXISTS idx_learning_signals_ws_observed`,
    `DROP INDEX IF EXISTS idx_messages_ws`,
  ]) {
    await sql.raw(statement).execute(db);
  }
}
