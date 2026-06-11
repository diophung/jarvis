# Production database migration plan

Goal: take Donna's persistence layer from "great local default" to a
production-grade architecture that can serve ~10M DAU / ~20K peak TPS without
a rewrite — while keeping the zero-config laptop experience intact.

Companion doc: [production-database.md](./production-database.md) — the
target architecture, scale math, partitioning/indexing strategy, and
operational runbooks. This file is the *plan and decision record*.

## 1. Current state (inspected 2026-06-12)

| Aspect | Today |
|---|---|
| Access layer | Kysely query builder; **services are the repositories** (each `services/*.ts` owns its SQL; `packages/core` is pure) |
| Engines | SQLite (default, WAL) or Postgres via `DATABASE_URL` (`pg.Pool` hardcoded `max: 10`, no timeouts) |
| Schema | 33 tables, portable SQL subset (TEXT/INTEGER/REAL, ISO timestamps, JSON-as-TEXT), camelCase↔snake_case via plugin |
| Migrations | Static Kysely runner (`0001`–`0003`), run via `pnpm db:migrate` and on boot |
| Tenancy | `workspace_id` on every row; all service queries filter by it (workspace = tenant; single owner user today, schema allows members) |
| Indexes | Sensible `(workspace_id, …)` composites on most hot tables |
| Vector search | `embedding_records.vector` JSON arrays, cosine computed in JS over ≤2000 newest rows |
| Cache | None |
| Idempotency | None (retried POSTs double-write) |
| Deletion/export | Memory export only; no account-wide export or deletion path |
| Observability | Audit log + LLM call logs; **no** DB query metrics, slow-query logs, pool stats, or readiness probe |
| Resilience | No retries, no circuit breaking, no statement timeouts; assistant context assembly fails closed if memory/retrieval throws |

### Entities persisted (the prompt's checklist → existing tables)

users → `users`; tenants → `workspaces`; user_identities → `auth_accounts`;
user_preferences → `user_preferences` + `learned_preferences`; user_memories
→ `memory_entries`; memory_evidence → `learned_preferences.sources` +
`learning_signals`; learning_signals → `learning_signals`; feedback_events →
`item_feedback`; assistant_actions → `agent_actions` + `approval_requests`;
tasks → `task_candidates`; documents → `uploaded_files` + `source_items`;
document_chunks → `retrieval_chunks`; embedding_records →
`embedding_records`; audit_log → `audit_logs`. **Missing:**
`idempotency_keys`, `data_deletion_requests` — added in this work.

### Hot request paths (read/write user state)

- Chat (`POST /conversations/:id/messages`): reads memories, retrieval
  chunks+embeddings, tasks, calendar items, digest, learned preferences;
  writes messages, signals.
- Feedback (`POST /tasks/:id/feedback` etc.): writes `item_feedback`,
  derived prefs, learning signals.
- Digest generation: reads scoring context (people, projects, prefs,
  feedback), writes digests + items.
- Worker: connector syncs (bulk upserts to `source_items`), learning runs,
  decay, approval expiry.

## 2. Decisions (with tradeoffs)

**D1 — Stay PostgreSQL-first; SQLite remains the local fallback.** The repo
already targets a portable SQL subset on Kysely with a Postgres dialect.
Aurora/AlloyDB/Cloud SQL/Neon are drop-in via `DATABASE_URL`. No new query
language, one operational surface.

**D2 — High-volume event data stays in Postgres, partitioned — not DynamoDB.**
`learning_signals`, `item_feedback`, `audit_logs`, `llm_call_logs` are
append-heavy. At 20K TPS peak (~60/40 read/write) a well-partitioned Postgres
with NVMe-class storage and read replicas handles this; a second database
engine (DynamoDB) would buy headroom we don't need yet at the cost of dual
operational expertise, dual backup/DR stories, and cross-store consistency
work. **Tradeoff documented:** if sustained event writes exceed ~50K rows/s
or storage growth outpaces partition pruning, the `learning_signals` /
`item_feedback` write paths are already isolated behind services, so a
wide-column adapter can be introduced per-table without touching callers.
Partitioning DDL (time-range, hash-by-tenant option) ships as documented SQL
for fresh production installs (see production-database.md §Partitioning).

**D3 — Services remain the repository layer for relational entities.** A
parallel "repository interface per table" layer would duplicate 30+ services
that already encapsulate their SQL behind typed interfaces in `context.ts`,
and conflicts with the repo's architecture. New **repository interfaces are
introduced exactly where multiple backends genuinely exist**: `Cache`
(memory/Redis), `VectorStore` (SQL-scan/pgvector), idempotency, deletion.

**D4 — pgvector for semantic memory, behind a `VectorStore` interface.** The
JSON-scan approach is O(corpus) per query and caps at 2000 candidates. The
interface keeps the scan adapter as the SQLite/local path and adds a pgvector
adapter (HNSW) that activates by feature detection. External vector DBs
(Qdrant/OpenSearch) can be added as adapters later; not hard-coded anywhere.

**D5 — Redis-compatible cache, strictly disposable.** In-memory LRU adapter
by default (zero config, per-process); Redis adapter when `DONNA_REDIS_URL`
is set, wrapped in a circuit breaker that fails open (cache miss) — Redis is
never a source of truth and never on the error path.

## 3. Work plan (vertical slices, in order)

1. **DB foundation** (`packages/db`): env-tunable pool (size, connect/idle
   timeouts), Postgres `statement_timeout`, query metrics + slow-query logs
   via Kysely's log hook, `checkDbHealth`, `withRetry` (safe ops only,
   exponential backoff + jitter), `CircuitBreaker` utility.
2. **Migration `0004_production_ops`**: `idempotency_keys`,
   `data_deletion_requests`, missing hot-path indexes.
3. **Idempotency**: `Idempotency-Key` header support on unsafe write routes
   (feedback, memory create, learning corrections, preference upserts) —
   stored request-hash + response replay, TTL cleanup in worker.
4. **Cache layer**: `Cache` interface + memory/Redis adapters + metrics;
   integrated on the hottest reads (settings, preferences-by-context) with
   write-through invalidation.
5. **Vector store**: `VectorStore` interface; extract current scan into
   `SqlScanVectorStore`; add `PgVectorStore` (pgvector, HNSW, feature
   detected); `indexing`/`retrieval` services consume the interface.
6. **Privacy ops**: account data export endpoint; deletion requests API +
   worker purge job (audited, idempotent, status-tracked).
7. **Resilience**: graceful degradation in assistant context assembly
   (memory/retrieval/digest failures → degraded context, not a 500);
   learning-ingestion backpressure guard; readiness endpoint
   (`/api/health/ready`) + metrics endpoint.
8. **Tooling**: SQLite→Postgres backfill CLI (`--dry-run`, batched,
   FK-ordered, verification counts); mixed-workload benchmark script.
9. **Docs & config**: production-database.md, .env.example, deployment.md,
   architecture.md updates.

## 4. Migration strategy (local/dev → production)

- **Schema versioning** stays in the existing static Kysely migrator —
  additive, backward-compatible migrations only; every migration has `down`.
- **Fresh production install**: set `DATABASE_URL`, run `pnpm db:migrate`,
  optionally apply the partitioning DDL before first traffic, set
  `DONNA_DEMO_SEED=false`.
- **Existing local data → production**: `pnpm --filter @donna/server exec
  tsx src/scripts/migrate-sqlite-to-postgres.ts --sqlite ./data/donna.db
  --dry-run` then without `--dry-run`. Copies all tables in FK-safe order in
  batches, skips rows that already exist (re-runnable), prints per-table
  source/target counts for verification.
- **Rollback**: migrations `0004+` are additive (new tables + indexes), so
  rollback = `down` migration (drops the new tables); no destructive changes
  to existing data. The backfill tool never deletes source data; rollback of
  a botched backfill = drop target DB and re-run.
- **Seed/fixtures**: existing demo seed continues to work on both engines;
  tests run against in-memory SQLite; Postgres integration tests gate on
  `TEST_DATABASE_URL` and skip otherwise.

## 5. Risks

- Partitioning is documented + scripted but not applied automatically to
  existing installs (retrofit requires a maintenance window; see runbook).
- The benchmark proves relative efficiency on a laptop, not 20K TPS; the
  scale math in production-database.md states the assumptions explicitly.
- Cache invalidation is workspace-keyed and write-through from this process;
  multi-replica deployments rely on short TTLs until pub/sub invalidation is
  added (documented as future work).
