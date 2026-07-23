# Production database architecture

How Jarvis's persistence layer is built to grow from one user on a laptop to
~10M DAU without a rewrite. Companion docs:
[production_database_migration_plan.md](./production_database_migration_plan.md)
(decision record + work plan), [deployment.md](./deployment.md),
[architecture.md](./architecture.md).

Guiding principle: boring, proven infrastructure — put each workload in the
database that fails least badly at scale.

## Store-per-workload map

| Workload | Store | Why |
|---|---|---|
| Relational, transactional state (users, tenants, identities, settings, preferences, tasks, calendar objects, connector metadata, memory metadata, approvals/audit) | **PostgreSQL** (Aurora / AlloyDB / Cloud SQL / Neon via `DATABASE_URL`) | Correctness, constraints, transactions, mature operations |
| High-volume append-only events (learning_signals, item_feedback, audit_logs, llm_call_logs) | **Partitioned PostgreSQL tables** (see Partitioning) | One operational surface; isolated behind services so a wide-column adapter (DynamoDB-style) can replace individual tables if sustained event writes outgrow Postgres (~50K rows/s) — the explicit tradeoff is documented in the migration plan (D2) |
| Semantic memory / RAG vectors | **`VectorStore` interface**: pgvector adapter on Postgres (in-database cosine, HNSW-indexable), SQL-scan adapter everywhere else; Qdrant/OpenSearch pluggable later | Vector DBs are retrieval engines, not profile stores; embedding_records stays the system of record |
| Hot reads (settings, preference lookups) | **Cache interface**: in-memory LRU per process (default) or Redis/Valkey (`JARVIS_REDIS_URL` — ElastiCache, Memorystore, Upstash) | Disposable by contract: every cache path fails open to the database |
| Blobs (uploads) | local disk or S3 (existing `JARVIS_STORAGE_DRIVER`) | unchanged |
| Local development | **SQLite (WAL)** — the zero-config default | identical schema via Kysely's portable SQL subset |

## Access patterns (and how each is served)

| Pattern | Path | Backing |
|---|---|---|
| Read preferences by user/context | `learning.getPreferencesByContext` | cache (60s TTL, write-through invalidation) → `learned_preferences` via `(workspace_id, user_id, status)` index |
| Write feedback event | `POST /api/feedback` (idempotency-key capable) | `item_feedback` insert + synchronous learning hook |
| Write learning signal | `learning.recordSignals` | privacy guard → fingerprint dedupe → `learning_signals` append; backpressure cap of 5K pending per workspace |
| Read recent memory | `memory.relevant` | `memory_entries` via `(workspace_id, enabled)` index |
| Search semantic memory | `retrieval.search` | keyword leg (chunk LIKE scan, bounded 500) + `VectorStore.search` |
| Upsert explicit preference | `POST /api/learning/preferences` (idempotent) | unique `(workspace, user, key, scope_key)` upsert |
| Generate daily briefing | digest worker | scoring context reads + digest/digest_items insert |
| Retrieve audit log | `GET /api/audit` | `(workspace_id, created_at)` index, limit+`before` cursor pagination |
| Delete all user data | `POST /api/account/delete-data` → worker | `data_deletion_requests` job; per-table workspace-scoped purge with accounting |
| Export all user data | `GET /api/account/export` | per-table workspace-scoped reads, row-capped with truncation flags |

Unbounded queries are prevented structurally: list endpoints take limits with
server-side caps, scans carry hard candidate limits, and Postgres enforces
`statement_timeout` (default 10s, `JARVIS_DB_STATEMENT_TIMEOUT_MS`) on every
query as the last line of defense.

## Scale math for 20K peak TPS / 10M DAU (assumptions, stated)

- Assume 10M DAU × ~40 requests/day ≈ 4.6K RPS average; 20K TPS peak with
  bursts. Assume ~60/40 read/write at the DB after caching.
- **Reads (~12K/s):** settings + preference lookups dominate and are cached
  (measured ~100% hit rate on hot keys in the benchmark; production estimate
  ≥90% with 30–60s TTLs) → ~1–2K/s reach Postgres, all single-digit-ms
  index point reads on `(tenant, user)` composites. Read replicas absorb
  growth; the service layer is already read/write separable per query.
- **Writes (~8K/s):** dominated by append-only events (signals, feedback,
  audit). Partitioned heap inserts with small composite indexes sustain
  >10K rows/s on Aurora r6g.2xl-class hardware; ingestion (connector sync)
  is worker-side and naturally batched.
- **Connections:** replicas × `JARVIS_DB_POOL_SIZE` must stay below the
  server limit — at 40 API replicas × 10 connections = 400, use RDS
  Proxy/pgbouncer (transaction pooling) beyond that.
- **The local benchmark** (`bench-db.ts`) exists to catch regressions and
  obvious inefficiencies (missing index → immediately visible p95 shift),
  *not* to certify internet-scale throughput.

## Partitioning & indexing

Implemented (portable, both engines — migrations `0001`–`0004`):

- Composite `(workspace_id, …)` indexes on every tenant-scoped hot path;
  `(workspace_id, user_id)` on preference tables; time-keyed indexes on all
  event/history tables; cross-workspace worker scans get `(status,
  expires_at)`-style indexes.
- All event reads are bounded (limits, watermarks, TTL pruning of pending
  signals).

Documented for fresh production installs (Postgres-only DDL; apply before
first traffic — retrofitting requires a copy-swap maintenance window):

```sql
-- Example: monthly range partitioning for high-volume event tables.
-- Repeat for item_feedback, audit_logs, llm_call_logs.
CREATE TABLE learning_signals (
  ... same columns as migration 0003 ...
) PARTITION BY RANGE (observed_at);
CREATE TABLE learning_signals_2026_06 PARTITION OF learning_signals
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
-- Create the next month's partition from a scheduled job; DROP old
-- partitions past retention instead of DELETE-ing rows.
```

Tenant-hash subpartitioning (`PARTITION BY HASH (workspace_id)` inside each
range) is the documented escape hatch if single-month partitions grow past
~100GB. Partition pruning keeps per-tenant, time-bounded queries on small
indexes, and retention becomes `DROP PARTITION` (no vacuum debt).

pgvector index, once corpora are large enough to matter (per embedding model
dimension):

```sql
CREATE INDEX idx_embedding_vectors_hnsw ON embedding_vectors
  USING hnsw ((embedding::vector(768)) vector_cosine_ops) WHERE dims = 768;
```

## Multi-tenancy & noisy neighbors

- Tenant = workspace. Every content row carries `workspace_id`; every
  service method takes it as the first argument and filters on it — there is
  no code path that queries content tables without a tenant filter
  (enforced by the tenant-isolation test suite; cache keys embed the
  workspace id; idempotency keys are unique per tenant+user).
- Noisy-neighbor protection: per-workspace learning backpressure (pending-
  signal cap), per-run item/signal caps, statement timeouts, bounded pools,
  and login rate limiting. Tenant-level request throttling at the API
  gateway is the documented next step for multi-region scale.
- Postgres row-level security is intentionally not enabled yet (single
  connection role); it is a compatible hardening step since every query
  already carries `workspace_id`.

## Reliability

- **Pooling/timeouts:** bounded pg pool with connect/idle timeouts; pool
  `error` handler (idle connection loss never crashes the process);
  server-side `statement_timeout`; SQLite `busy_timeout` for API+worker
  co-writes.
- **Retries:** `withRetry` (exponential backoff + full jitter) retries only
  classified-transient errors (connection failures, failover, deadlock,
  serialization, SQLITE_BUSY) — never constraint or application errors.
- **Circuit breaking:** the Redis cache adapter fails fast through a
  breaker; an open breaker degrades every cache call to a miss instantly.
- **Idempotency:** `Idempotency-Key` on unsafe writes — stored response
  replay, 409 on body-mismatch reuse and concurrent duplicates, 5xx
  responses release the key so retries re-execute.
- **Transactions:** relational multi-row writes are single-statement or
  per-row idempotent (upserts keyed by stable ids); the migration runner is
  transactional per migration on Postgres.
- **Graceful degradation:** assistant context assembly tolerates each
  source failing independently (memory/retrieval/digest down → answer from
  the rest, log the failure, never 500); semantic search degrades to
  keyword; cache failures degrade to DB reads.
- **Dead-letter/backpressure:** failed deletion jobs persist as
  `status='failed'` with the error (re-runnable, alertable via the metrics
  endpoint); learning ingestion stops producing when the pending backlog
  exceeds its cap and recovers idempotently.
- **Health:** `/api/health` (liveness, no deps), `/api/health/ready` (DB
  round-trip with its own deadline; 503 ⇒ LB stops routing),
  `/api/health/metrics` (operational counters).

## High availability & disaster recovery (deployment posture)

- Run managed Postgres with multi-AZ synchronous standby (Aurora/Cloud SQL
  HA); failover appears to Jarvis as transient connection errors, which the
  retry classifier and pool replacement absorb.
- PITR (continuous WAL archiving) with ≥7-day window; daily snapshots
  retained ≥30 days. RPO ≈ seconds (managed PITR), RTO = managed failover
  (~30–120s).
- Read replicas for read scaling and as cross-region DR seeds; multi-region
  active-active is future work (the event tables are append-only and
  conflict-free by id, which keeps that door open).
- Cache and vector side-table are rebuildable: Redis can be flushed at any
  time; `embedding_vectors` can be re-derived from `embedding_records`.
- Backups restore drill: restore snapshot → run `pnpm db:migrate` (no-op if
  current) → point `DATABASE_URL` → readiness goes green.

## Security & privacy

- **Encryption in transit:** require `sslmode=require` (or stricter) in
  production `DATABASE_URL`; Redis with TLS (`rediss://`).
- **Encryption at rest:** assumed from the managed platform (Aurora/Cloud
  SQL/ElastiCache encrypt volumes + snapshots). Field-level encryption hooks
  already exist for the most sensitive material — OAuth tokens and UI-entered
  API keys are AES-256-GCM encrypted by the app (`JARVIS_TOKEN_ENCRYPTION_KEY`
  / `JARVIS_SECRET`) before they reach the database; new sensitive fields
  should use the same `SecretsService.encrypt` path.
- **No sensitive data in logs/metrics:** slow-query logs record
  parameterized SQL only (placeholders, never values); audit metadata is
  redacted; the metrics endpoint exposes counts and latencies only; LLM call
  logs never contain content.
- **Tenant isolation:** see Multi-tenancy; verified by tests.
- **Export/delete/retention:** `GET /api/account/export`,
  `POST /api/account/delete-data` (worker-processed, audited, status-
  tracked); retention hooks today: idempotency-key TTL GC, pending-signal
  TTL pruning, approval expiry; partition-drop retention for event tables is
  the documented production path.

## Observability

`GET /api/health/metrics` (PII-free):

- query totals, error counts, latency p50/p95/p99/max, per-`operation table`
  stats, slow-query count (+ structured slow-query log lines with
  parameterized SQL), retry count
- pool usage (total/idle/waiting/max — sustained waiting > 0 ⇒ saturation)
- cache backend, hit/miss/error counts, breaker state
- active vector backend, open deletion-job count

Wire this into your scraper of choice; the JSON is stable and flat. Jarvis
has no distributed tracing today — when one is added, the Kysely log hook in
`packages/db/src/client.ts` is the single place to attach spans.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | unset (SQLite) | `postgres://` enables Postgres |
| `JARVIS_DB_POOL_SIZE` | 10 | pool max per process |
| `JARVIS_DB_CONNECT_TIMEOUT_MS` | 5000 | connection acquisition deadline |
| `JARVIS_DB_IDLE_TIMEOUT_MS` | 30000 | idle connection recycling |
| `JARVIS_DB_STATEMENT_TIMEOUT_MS` | 10000 | server-side query deadline |
| `JARVIS_DB_SLOW_QUERY_MS` | 250 | slow-query log threshold |
| `JARVIS_REDIS_URL` | unset (memory) | shared cache backend |
| `JARVIS_CACHE_TTL_SECONDS` | 60 | default hot-read TTL |

Local development needs none of these — SQLite + in-memory cache + SQL-scan
vectors boot with zero configuration, exactly as before.

## Runbooks

- **Adopt Postgres from a laptop install:** stop Jarvis → `--dry-run` the
  backfill → run `src/scripts/migrate-sqlite-to-postgres.ts` → set
  `DATABASE_URL` → start → check `/api/health/ready`.
- **Botched backfill:** the tool never touches the source; drop/recreate the
  target database and re-run (it is also idempotent — plain re-runs only
  copy missing rows).
- **Roll back migration 0004:** additive only; `down` drops the two new
  tables and indexes.
- **Redis outage:** nothing to do — breaker opens, hit rate drops to 0, DB
  absorbs reads; watch p95 on the metrics endpoint.
- **Failed deletion job:** visible in `/api/health/metrics`
  (`deletionJobs.open`) and the request row (`status='failed'`, error);
  fix the cause, set the row back to `pending`, the worker re-claims it.
