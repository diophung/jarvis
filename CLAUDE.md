# CLAUDE.md

Donna is a self-hostable digital executive assistant: it syncs email, chat, calendar, and cloud storage into one normalized model, scores what matters with explainable rules, writes a daily debrief, answers questions over your real data with citations, and takes approval-gated actions. It runs fully without any AI key (demo mode).

## Commands

Requires Node >= 20 and pnpm 9 (`corepack enable`). It's a pnpm workspace monorepo.

```bash
pnpm install
pnpm dev            # API (:3001, tsx watch) + web UI (:5173, Vite) in parallel
pnpm dev:server     # API only      pnpm dev:web   # UI only
pnpm worker         # standalone background worker
pnpm build          # build all (server "build" is a typecheck; web builds bundle)
pnpm test           # all suites (vitest, `pnpm -r --no-bail`)
pnpm typecheck      # tsc --noEmit across the workspace
pnpm lint           # eslint .
pnpm db:migrate     # apply migrations (also runs automatically on server start)
pnpm seed:demo      # force demo seed (no-op when sources already exist)
```

Per-package test: `pnpm --filter @donna/server test`. Single test: `pnpm --filter @donna/server exec vitest run src/services/scoring.test.ts` (add `-t "<name>"` to filter by test name). No env needed — Donna boots in demo mode (SQLite at `./data/donna.db`, mock sources, mock LLM, local auto-login). Copy `.env.example` to `.env` to configure more.

## Architecture

`apps/web` (React 18 + Vite + Tailwind) → HTTP → `apps/server` (Fastify 5 API + in-process worker) → `packages/{connectors, llm, db, core}`. `connectors`, `llm`, `db` depend on `core`; **`core` depends on nothing internal**.

The central split: **everything in `packages/core` is pure and deterministic** (scoring engine, digest planner, normalization/chunking, policy evaluation — all take `now` as a parameter, never read the clock or do IO). `apps/server/src/services` owns all IO, persistence, and wiring. Match this when adding logic.

- **Ingestion** (`services/ingestion.ts`): connector sync → `core/ingestion` normalize/dedupe/chunk → upsert `source_items` → people → index into `retrieval_chunks`.
- **Scoring & digest** (`services/scoring.ts`, `digest.ts` over `core/scoring`, `core/digest`): rules-first 0–100 importance/urgency/effort with a `ScoreSignal[]` explaining each ranking; optional LLM refinement clamped to ±15.
- **Chat** (`services/assistant.ts`): SSE stream that assembles real context (memory, retrieval, tasks, calendar, digest), routes to the `chat` LLM provider, emits citations + suggested actions.
- **Self-learning** (`services/learning.ts`, `personalization.ts` over `core/learning`): learns tendencies from behavior/feedback/edits as confidence-scored, per-context `LearnedPreference`s with evidence trails; the pure engine handles extract/infer/decay/style/privacy (sensitive attributes filtered out), the service persists and applies them to chat, drafting, and the digest.
- **Actions** (`services/actions.ts` + `core/policy`, `core/capabilities`): every action goes through `propose` → policy eval → deny / auto-approve / require-approval → `execute` → audit. External actions always require sign-off.
- **Service container**: `apps/server/src/context.ts` defines interfaces; `services/index.ts` `buildServices` wires factories (`createXService(deps)`) in dependency order; routes export `registerXRoutes(app, ctx)`, assembled in `app.ts`.
- **LLM** (`packages/llm`): pure `fetch` adapters (anthropic, gemini, openai_compatible, mock), no vendor SDKs; `services/llm-router.ts` routes 5 tasks (chat, summarization, digest, classification, embedding); falls back to mock = demo mode.

Deep dives live in `docs/` (architecture.md, developer-guide.md, connectors.md, api-contract.md, self-learning.md).

## Conventions

- **ESM with `.js` import extensions** on all relative imports, even between `.ts` files. Runs under `tsx`/vitest with no build step.
- **String unions, not TS enums** — all live in `packages/core/src/enums.ts` as `as const` arrays.
- **Portable SQL** (SQLite + Postgres): only TEXT/INTEGER/REAL; prefixed text ids via `newId('itm')` (`core/ids.ts`); ISO-8601 text timestamps; integer `0|1` booleans. Migrations are statically imported in `packages/db/src/migrate.ts` — add `000N_*.ts` and register it there.
- **JSON-as-text**: parse with `fromJson(text, fallback)`, write with `toJson(value)` from `@donna/core` — never raw `JSON.parse`. camelCase in code, snake_case in SQL (Kysely `CamelCasePlugin`).
- **Secrets** referenced by env var *name* (`apiKeyEnv`, `SecretResolver`) or stored AES-256-GCM-encrypted; secret values never appear in logs, errors, or audit metadata.
- **Tests** are vitest, colocated as `*.test.ts`. `createTestDb()` / `seedWorkspace()` (`apps/server/src/test/helpers.ts`) for DB; route tests use `app.inject` with a stubbed auth hook; stub the LLM with `createMockAdapter()` + `isMock: true`; stub connector network with `vi.stubGlobal('fetch', …)`. Code style: Prettier (singleQuote, semi, trailingComma all, printWidth 100).
