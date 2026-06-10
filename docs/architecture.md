# Donna architecture

Donna is a digital executive assistant: it syncs email, chat, calendar, and
cloud storage into one normalized model, scores what matters, writes a daily
debrief, answers questions over your real data, and takes approval-gated
actions on your behalf. This document maps the system: subsystems, data flows,
the data model, the service container, demo mode, and the worker.

Companion docs:

- [api-contract.md](./api-contract.md) — the binding REST contract between server and web client
- [connectors.md](./connectors.md) — per-provider connector reference
- [developer-guide.md](./developer-guide.md) — conventions and how to extend the system
- [deployment.md](./deployment.md) — running Donna locally, in Docker, and in the cloud

## Subsystem map

The spec defines ten layers. Each maps to a concrete package or directory:

| # | Layer | Where it lives |
|---|-------|----------------|
| 1 | Connector | `packages/connectors` — `Connector` interface, registry, mock + real provider adapters |
| 2 | Ingestion & normalization | `packages/core/src/ingestion` (pure normalize/chunk) + `apps/server/src/services/ingestion.ts` (sync pipeline) |
| 3 | LLM provider | `packages/llm` — fetch-based adapters (anthropic, gemini, openai/openai_compatible, mock), `LlmClient`, structured output |
| 4 | Retrieval | `apps/server/src/services/indexing.ts` + `retrieval.ts` over `retrieval_chunks` / `embedding_records` |
| 5 | Memory & preferences | `apps/server/src/services/memory.ts`, `feedback.ts` + `memory_entries` / `user_preferences` tables |
| 6 | Priority intelligence | `packages/core/src/scoring` (pure engine) + `apps/server/src/services/scoring.ts` |
| 7 | Assistant orchestration | `apps/server/src/services/assistant.ts`, `digest.ts` + `packages/core/src/digest` (pure planner) |
| 8 | Permission & approval | `packages/core/src/capabilities.ts` + `policy/engine.ts` (pure) + `apps/server/src/services/actions.ts` |
| 9 | UX & settings | `apps/web` (React 18 + Vite + Tailwind) + `apps/server/src/routes/*` |
| 10 | Audit & observability | `apps/server/src/services/audit.ts` + `audit_logs`, `llm_call_logs`, `connector_runs` tables |

Package dependency direction (no cycles):

```
apps/web ──HTTP──> apps/server ──> packages/{connectors, llm, db, core}
packages/connectors ──> packages/core
packages/llm        ──> packages/core
packages/db         ──> (kysely only; schema mirrors core entities)
packages/core       ──> (no internal deps; pure domain logic)
```

A deliberate split runs through the whole codebase: **everything in
`packages/core` is pure and deterministic** (no wall clock, no network, no DB
— scoring, digest planning, normalization, chunking, policy evaluation all
take `now` as input), while `apps/server/src/services` owns IO, persistence,
and wiring.

## Data flows

### 1. Ingestion: sync → normalize → dedupe → people → index

Entry points: `POST /api/sources/accounts/:id/sync`, the worker's
`syncDueAccounts`, and the first-boot demo seed. All converge on
`IngestionService.syncAccount` (`apps/server/src/services/ingestion.ts`):

1. **Sync** — resolve the account's provider in the `ConnectorRegistry`, build
   a `ConnectorContext` (account settings + env-backed `SecretResolver`), and
   page through `connector.sync(ctx, { mode, cursor, limit })`. Each page
   returns `RawSourceItem[]` plus an opaque `nextCursor`; a hard cap of 50
   pages per run prevents runaway loops. The cursor is persisted on
   `source_accounts.sync_cursor` so the next incremental run resumes exactly
   where this one finished.
2. **Normalize** — `normalizeRawItem` (`packages/core/src/ingestion/normalize.ts`)
   produces a `NormalizedItemInput`: trimmed fields, lowercased emails, a
   derived ≤200-char snippet, a `dedupeKey` (provider `dedupeHint` such as an
   ICS UID wins; otherwise an FNV-1a 64 hash of identifying fields), and a
   `contentHash` over title + body + timestamp.
3. **Upsert & dedupe** — items are upserted by `(accountId, externalId)`;
   unchanged `contentHash` means no write and no re-index. Cross-source
   duplicates (e.g. the same calendar event from two accounts) are caught by
   `dedupeKey`.
4. **People** — observed senders and participants with email addresses are
   upserted into `people`; senders get `interaction_count` +1 and a fresh
   `last_interaction_at`, unknown participants are created (workspace people
   are cached per run by email).
5. **Index** — new/changed item text is chunked (`chunkText`: 1200 chars,
   150 overlap) into `retrieval_chunks` and embedded when an embedding
   provider is configured (best-effort; keyword search works without it).
6. **Record** — a `connector_runs` row (items seen/created/updated, errors,
   cursor before/after) plus a `connector.sync` audit entry.

### 2. Prioritization & digest: score → plan → narrate → digest

- **Score** — `ScoringService.rescoreWorkspace` builds a `ScoringContext`
  (VIP people, project keywords, preferences, feedback, `now`) and runs the
  deterministic engine in `packages/core/src/scoring/engine.ts` over recent
  items. The engine is rules-first: keyword/deadline/sender-importance rules
  produce 0–100 importance/urgency/effort scores, and every rule that fires
  appends a `ScoreSignal` so the UI can explain *why*. An optional LLM
  refinement (task `classification`) can adjust scores, but its influence is
  clamped to ±15. Results are upserted as `task_candidates` — stable per
  `sourceItemId`, origin `scoring`, never overwriting user-modified status.
- **Plan** — `DigestService.generate` rescores, selects candidates, and calls
  the pure planner (`packages/core/src/digest/planner.ts`), which places each
  candidate in **exactly one** section (`most_important`, `most_urgent`,
  `high_effort`, `meetings_prep`, `follow_ups`, `missed`, `reading`, `risks`;
  max 5 per section) and renders deterministic fallback markdown.
- **Narrate** — when the routed `digest` provider is not the mock, the plan is
  handed to the LLM to write the summary/plan narrative; on any failure (or in
  demo mode) the deterministic fallback markdown is used. Digests are never
  mutated — regeneration creates a new row linked via `supersedes_digest_id`.
- **Persist** — `digests` + ranked `digest_items` rows (each item carries its
  section, planning category, levels, explanation, and signals).

### 3. Chat: context assembly → stream → citations → actions

`POST /api/conversations/:id/messages` is an SSE stream (see
[api-contract.md](./api-contract.md)). `AssistantService.respond`
(`apps/server/src/services/assistant.ts`):

1. Persists the user message, then assembles context from real workspace data:
   relevant memories (`memory.relevant`), hybrid retrieval results
   (`retrieval.search`), open prioritized tasks, calendar events in the next
   36 hours, and the latest digest.
2. Routes to the configured `chat` provider via the LLM router and streams
   `delta` events; in demo mode (mock provider) a deterministic answerer
   composes the reply from the same real context and streams it word-by-word.
3. Emits `citations` (source items / files backing the answer) and suggested
   `actions`.
4. Detects conservative agentic intents (draft/send/schedule/post) and routes
   them through `ActionsService.propose` — if a proposal needs sign-off, an
   `approval_created` event carries the approval id to the UI.
5. Captures durable preferences ("always…", "never…", "remember that…") into
   memory, and finally emits the persisted assistant `message`.

### 4. Actions: propose → policy → approve → execute → audit

`ActionsService` (`apps/server/src/services/actions.ts`) is the permission
core. Every action — whether suggested in chat or requested via the API —
goes through `propose`:

1. An `agent_actions` row is created with the capability (e.g. `email.send`),
   params, and target.
2. `evaluatePolicy` (`packages/core/src/policy/engine.ts`) resolves the
   workspace's enabled `permission_policies` rules against the capability:
   exact pattern beats prefix wildcard (`email.*`) beats `*`; at equal
   specificity deny > require_approval > auto_approve; with no matching rule,
   the `CAPABILITY_CATALOG` default applies. Unknown capabilities are never
   auto-approved.
3. Outcomes: **deny** (action marked denied, audited), **auto-approve**
   (executed inline), or **require approval** (an `approval_requests` row with
   a human-readable preview, risk level, and a 7-day expiry).
4. On approval (`POST /api/approvals/:id/decide`), `execute` runs the action:
   external capabilities map to connector write actions
   (`email.send → send_email`, `calendar.create_invite → create_event`,
   `chat.post → post_message`, …) executed through `connector.execute`; local
   capabilities (drafts, notes, memories) execute against the DB.
5. Every transition is written to `audit_logs`
   (`agent.action.proposed/executed/failed`, `approval.created/approved/denied/expired`).

## Normalized data model

One migration (`packages/db/src/migrations/0001_init.ts`) defines all 28
tables in a portable SQL subset that runs identically on SQLite and Postgres.

**Portability conventions** (enforced throughout):

- only `TEXT` / `INTEGER` / `REAL` column types
- ids are prefixed text (`itm_…`, `tsk_…` — see `IdPrefix` in
  `packages/core/src/ids.ts`; nanoid, 20 lowercase alphanumeric chars)
- timestamps are ISO-8601 text
- booleans are integer `0 | 1`
- structured fields are JSON stored as `TEXT`, parsed with
  `fromJson()` / serialized with `toJson()` from `@donna/core`
- columns are snake_case in SQL, camelCase in code (Kysely `CamelCasePlugin`)

The 28 tables, grouped:

| Group | Tables | Notes |
|-------|--------|-------|
| Identity | `users`, `workspaces` | single owner user per workspace; `password_hash` only set in password auth mode |
| Sources & ingestion | `source_accounts`, `source_items`, `source_attachments`, `connector_runs`, `uploaded_files` | `source_accounts` holds provider, status, settings JSON, and the opaque `sync_cursor`; `source_items` is the normalized item store (`dedupe_key`, `content_hash`, sender/participants as JSON `PersonRef`s) |
| People & projects | `people`, `organizations`, `projects` | priority context: person `importance` (`vip`…`ignore`), project keywords and due dates feed scoring |
| Prioritization & digests | `task_candidates`, `digests`, `digest_items`, `item_feedback` | scores, levels, planning category, and `signals` (JSON `ScoreSignal[]`) explain every ranking |
| Memory & preferences | `memory_entries`, `user_preferences` | durable personalization; memory entries carry kind, origin, confidence, enabled flag, provenance |
| Permissions & actions | `permission_policies`, `approval_requests`, `agent_actions` | the policy/approval state machine described above |
| Conversations | `conversations`, `messages` | messages store citations and suggested actions as JSON |
| LLM | `llm_provider_configs`, `llm_task_routes`, `llm_call_logs` | provider configs hold `api_key_env` (env var *name*) or `api_key_encrypted` (AES-256-GCM, key derived from `DONNA_SECRET`); call logs record counts/latency only — never message content |
| Retrieval | `retrieval_chunks`, `embedding_records` | chunk text + JSON metadata; vectors stored as JSON number arrays |
| Audit & settings | `audit_logs`, `app_settings` | audit metadata is redacted before write; settings are workspace-scoped JSON values |

## Service container

`apps/server/src/context.ts` defines every service interface plus the
`AppContext` shape:

```ts
export interface Services {
  audit; settings; secrets; llm; ingestion; indexing; retrieval; scoring;
  digest; actions; memory; feedback; assistant; storage; uploads;
}

export interface AppContext {
  config: AppConfig;          // parsed env (apps/server/src/config.ts)
  db: Db;                     // Kysely<DB>
  connectors: ConnectorRegistry;
  services: Services;
}
```

`buildServices` (`apps/server/src/services/index.ts`) wires the container in
dependency order — e.g. `ingestion` receives `{ db, connectors, secrets,
audit, settings, indexing }`, `assistant` receives `{ db, llm, retrieval,
memory, actions, settings, audit }`. Each service is a factory function
(`createXService(deps)`) returning a plain object implementing its
`context.ts` interface, so tests can substitute any dependency with a stub.

Route modules (`apps/server/src/routes/*.ts`) each export
`registerXRoutes(app, ctx)` and are assembled in `buildApp`
(`apps/server/src/app.ts`), which also installs cookie/CORS/multipart
plugins, the error handler, session auth, and (when `DONNA_PUBLIC_DIR` is
set) static serving of the built web UI with an SPA fallback.

Two entrypoints share this container: `src/index.ts` (API server, plus the
in-process worker unless `DONNA_INLINE_WORKER=false`) and `src/worker.ts`
(standalone worker).

## LLM routing

`LlmRouterService` (`apps/server/src/services/llm-router.ts`) resolves a
provider per task (`chat`, `summarization`, `digest`, `classification`,
`embedding`):

1. `llm_task_routes` row for the task → its provider config
2. otherwise any enabled provider config (non-mock preferred, oldest first)
3. otherwise the built-in mock adapter (`isMock: true` → demo mode)

API keys resolve env-named key first (`api_key_env`), then the encrypted
stored key. Embeddings never fall back to mock implicitly — `embeddingClient`
returns `null` when no configured provider supports embeddings, so semantic
search simply stays off rather than producing fake similarity.

Adapters are pure `fetch` clients (no vendor SDKs); `LlmClient` adds timeouts,
retries with exponential backoff on retryable `LlmError` codes, and emits one
content-free usage event per call into `llm_call_logs` + the audit log.

## Demo mode

Donna is fully functional with zero credentials. Two pieces make that work:

1. **Mock connectors + demo dataset** — `createDemoDataset(now)`
   (`packages/connectors/src/demo/dataset.ts`) is a pure function generating a
   coherent narrative workspace relative to `now`: Alex Chen, VP Product at
   Meridian Labs; the Atlas launch six days out; a Q3 budget decision due
   Friday; a blocked vendor migration; a buried email from a key customer.
   Four mock connectors (email, chat, calendar, storage) serve this dataset
   with real cursor semantics — the first incremental sync after a full sync
   yields a couple of "newly arrived" items, the next yields nothing. On first
   boot (`DONNA_DEMO_SEED=true`, the default), `bootstrap`
   (`apps/server/src/bootstrap.ts`) seeds people, projects, and the four mock
   accounts, runs a full sync, and rescores the workspace.
2. **Deterministic mock LLM + demo answerer** — when no provider is
   configured the router returns the mock adapter, and the assistant switches
   to `composeDemoAnswer`, which builds answers from *real* scored data
   (priorities, calendar, retrieval hits) with citations, appending a clear
   "demo mode" footer. Digests likewise fall back to the planner's
   deterministic markdown. The mock adapter's embeddings are seeded
   pseudo-vectors so even semantic search is demoable offline.

Scoring, digest planning, and search are deterministic engines that never
required an LLM in the first place, so demo mode exercises the same code
paths as production minus the narrative polish.

## Worker

`createWorkerLoop` (`apps/server/src/worker-loop.ts`) ticks every 60 seconds.
Each tick runs three independent sub-jobs, each in its own try/catch so one
failure never blocks the others:

1. **Scheduled digests** — per workspace, if the `digest.schedule` setting is
   enabled and its cron expression (evaluated with `croner`) has an occurrence
   since `digest.lastScheduledAt` (or 24 h ago), generate a `scheduled` digest
   for the workspace owner and advance the marker.
2. **Connector syncs** — `ingestion.syncDueAccounts`: every connected account
   whose `last_sync_at` is older than the `sync.intervalMinutes` setting
   (default 15) gets an incremental sync.
3. **Approval expiry** — pending `approval_requests` past `expires_at` (set 7
   days from creation) become `expired`, audited as `approval.expired`.

The loop runs in-process with the API by default; set
`DONNA_INLINE_WORKER=false` and run `pnpm --filter @donna/server worker` to
split it into its own process (see [deployment.md](./deployment.md)).
