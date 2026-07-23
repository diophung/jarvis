# Jarvis

Jarvis is a self-hostable digital executive assistant that watches your email, chat, calendar, cloud storage, and uploaded files, and tells you what actually matters. It scores every item with deterministic, explainable rules — you can always open "Why this matters" and see exactly which signals fired and with what weight. It works fully without any AI key (demo mode), and gets stronger when you plug in a local model (Ollama, vLLM, SGLang) or a cloud provider (Anthropic, OpenAI, Gemini).

The core loop:

```
connect sources / upload files
        │
        ▼
Jarvis scores importance, urgency, and effort  ← explainable signals, your feedback
        │
        ▼
daily debrief + chat with citations back to the source
        │
        ▼
approval-gated actions (send, schedule, post) — external actions always ask first
```

## Quick start (local, zero config)

Requirements: Node >= 20 and pnpm 9 (`better-sqlite3` ^12 ships prebuilt binaries for current Node versions, so there is no native build step on common platforms).

```bash
pnpm install
pnpm dev
```

- Web UI: http://localhost:5173 (Vite dev server, proxies `/api` to the API)
- API: http://localhost:3001 (Fastify)

No configuration, no API keys, no database setup. On first boot the server:

1. runs migrations against a local SQLite file at `./data/jarvis.db`,
2. creates the owner user and a single workspace, and signs you in automatically (local auth mode),
3. seeds a demo workspace: four mock sources (email, chat, calendar, cloud storage) with a coherent narrative — you are *Alex Chen, VP Product at Meridian Labs*, with a launch in 6 days, a budget decision due Friday, a blocked vendor migration, and a buried email from a key customer — plus the matching people and projects, then syncs and scores everything.

Without an AI provider Jarvis runs in **demo mode**: scoring, the daily debrief, search, and chat all work, driven by deterministic rules over the real seeded data. A banner in the UI tells you responses are mocked until you add a model.

Useful scripts:

```bash
pnpm dev          # API (:3001) + web (:5173) in parallel
pnpm dev:server   # API only
pnpm dev:web      # web only
pnpm worker       # standalone background worker
pnpm seed:demo    # re-run the demo seed (no-op if sources already exist)
pnpm db:migrate   # run migrations explicitly (also runs on server start)
pnpm test         # all package test suites
pnpm typecheck    # tsc across the workspace
pnpm lint         # eslint
```

## Docker

```bash
docker compose up --build
```

This runs two containers from one image:

- `jarvis` — the API server, which also serves the built web UI, on http://localhost:3001
- `worker` — the background worker (scheduled digests, periodic syncs, approval expiry)

Data (SQLite + uploads) lives in the `jarvis-data` volume. The demo workspace is seeded on first boot, same as local dev.

Optional profiles:

```bash
# Postgres instead of SQLite (point DATABASE_URL at the postgres service)
DATABASE_URL=postgres://jarvis:jarvis@postgres:5432/jarvis \
  docker compose --profile postgres up --build

# Local Ollama container for LLM inference (port 11434)
docker compose --profile ollama up --build
```

Note: the compose file passes `DATABASE_URL` through from your environment — starting the `postgres` profile does not rewire Jarvis automatically. The compose file sets `JARVIS_INLINE_WORKER=false` on the `jarvis` service so the scheduler runs only in the dedicated worker.

## Configuring AI providers

Everything is managed in **Settings → AI Providers** in the UI: add providers (with presets for Anthropic, OpenAI, Gemini, Ollama, vLLM, SGLang, or any other OpenAI-compatible endpoint), check their health, and route tasks to them. API keys entered in the UI are encrypted with `JARVIS_SECRET` before they touch the database; alternatively, reference an environment variable by name so the key is never stored at all.

Env bootstrap: on first boot, if no providers are configured yet, Jarvis creates provider entries from any of these env vars — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `JARVIS_LOCAL_LLM_BASE_URL` + `JARVIS_LOCAL_LLM_MODEL` (with optional `JARVIS_LOCAL_LLM_API_KEY_ENV` and `JARVIS_LOCAL_EMBEDDING_MODEL`). The bootstrap stores the env var *name*, not the key.

### Local inference

All local servers use the same `openai_compatible` provider kind — one fetch-based adapter covers OpenAI, vLLM, Ollama, SGLang, LM Studio, llama.cpp, and friends. Run your server, then add a provider in the UI (or set the two `JARVIS_LOCAL_LLM_*` env vars before first boot).

**Ollama**

```bash
ollama pull llama3.1:8b
ollama serve          # usually already running if you installed the app
```

Base URL: `http://localhost:11434/v1` · Model: `llama3.1:8b` (or any model you pulled). For semantic search, also pull an embedding model (e.g. `ollama pull nomic-embed-text`) and set it as the provider's embedding model.

**vLLM**

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct
```

Base URL: `http://localhost:8000/v1` · Model: the model id you passed to `vllm serve`.

**SGLang**

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct
```

Base URL: `http://localhost:30000/v1` · Model: the model path you launched with.

### Per-task model routing

Five tasks can each be routed to a different provider and model: **chat**, **summarization**, **digest**, **classification**, and **embedding**. Mix and match — e.g. a local model for summaries and a stronger cloud model for the daily debrief. Each provider card has a **Check health** button (reachability + auth, with latency); a collapsible **Recent model calls** table shows task, model, status, latency, and token counts (Jarvis logs call metadata only, never message content).

### Demo mode and the local/cloud indicator

With no provider configured, the router falls back to a built-in mock adapter: chat answers are composed deterministically from your real scored data (with a visible footer saying so), and the digest uses its rule-based narrative. Embeddings never silently fall back to mock — semantic search simply stays off until a real embedding provider exists.

Every provider card states where your data goes: local providers show **"Runs locally — data stays on your machine"**, cloud providers show **"Cloud — data is sent to <provider>"**. The status banner also says whether chat is currently running locally.

## Environment variables

Every variable is optional for local use — Jarvis boots with zero env vars. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_PORT` | `3001` | API server port. |
| `JARVIS_HOST` | `0.0.0.0` | API bind address. |
| `JARVIS_SECRET` | dev fallback | Signs session cookies and encrypts API keys stored via the UI. **Required in production** — a warning is logged when the dev fallback is in use. |
| `JARVIS_LOG_LEVEL` | `info` | `fatal`–`trace`. |
| `DATABASE_URL` | unset | Set a `postgres://` URL to use Postgres; unset means local SQLite. |
| `JARVIS_DATA_DIR` | `./data` | Root for the SQLite file and uploaded files. |
| `JARVIS_STORAGE_DRIVER` | `local` | `local` filesystem or `s3` object storage for uploads. |
| `JARVIS_S3_BUCKET` / `JARVIS_S3_REGION` / `JARVIS_S3_ENDPOINT` | unset | Upload bucket when driver is `s3`; endpoint enables MinIO/R2 (path-style). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | unset | AWS credentials via the SDK's standard chain (S3 storage and the S3 source connector). |
| `JARVIS_AUTH_MODE` | `local` | `local` = single-user auto-login; `password` = email + password login, with self-service registration and any configured OAuth login providers. See [docs/auth.md](docs/auth.md). |
| `JARVIS_OWNER_EMAIL` | `you@example.com` | Owner account email, created on first boot. |
| `JARVIS_OWNER_NAME` | `Jarvis User` | Owner display name. |
| `JARVIS_OWNER_PASSWORD` | unset | Owner password, hashed on first boot (set it when using `password` mode). |
| `JARVIS_ALLOW_SIGNUP` | `true` | Allow self-service registration in `password` mode. |
| `JARVIS_COOKIE_SECURE` | `false` | `Secure` attribute on cookies — set `true` behind HTTPS (required for Apple login). |
| `JARVIS_PUBLIC_URL` | `http://localhost:<port>` | Public base URL of the API; OAuth redirect URIs are built from it. Required behind a reverse proxy. |
| `JARVIS_TOKEN_ENCRYPTION_KEY` | falls back to `JARVIS_SECRET` | Dedicated key for OAuth-token encryption at rest. |
| `JARVIS_DEMO_SEED` | `true` | Seed the demo workspace on first boot (skipped if any source is already connected). |
| `JARVIS_WEB_ORIGIN` | `http://localhost:5173` | Allowed CORS origin for the dev web server. |
| `JARVIS_PUBLIC_DIR` | unset | Serve a built web bundle from the API server (the Docker image sets it). |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | unset | Bootstrap cloud providers on first boot (referenced by env name, never copied). |
| `JARVIS_LOCAL_LLM_BASE_URL` / `JARVIS_LOCAL_LLM_MODEL` | unset | Bootstrap a local OpenAI-compatible provider. |
| `JARVIS_LOCAL_LLM_API_KEY_ENV` | unset | Name of an env var holding the local endpoint's key, if it needs one. |
| `JARVIS_LOCAL_EMBEDDING_MODEL` | unset | Embedding model for the local provider (enables semantic search). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Google OAuth client: "Sign in with Google" **and** the Gmail / Drive / Calendar connect buttons. |
| `GOOGLE_REFRESH_TOKEN` | unset | Advanced/headless alternative for the Google connectors (env-supplied refresh token instead of the connect buttons). |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | unset | "Sign in with Facebook". |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | unset | "Sign in with Apple" (Services ID + ES256 key; `\n`-escaped PEM). HTTPS only. |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` / `MS_REFRESH_TOKEN` | unset | Outlook / Teams / OneDrive connectors (Microsoft Graph). |
| `SLACK_BOT_TOKEN` | unset | Slack connector. |
| `JARVIS_SOURCE_S3_BUCKET` / `JARVIS_SOURCE_S3_REGION` | unset | S3 bucket used as a *source* (document listing), distinct from upload storage. |
| `JARVIS_INLINE_WORKER` | `true` | Set `false` to disable the in-process scheduler when running a dedicated worker (not in `.env.example`; read by the server directly). |

## Connector setup

**Mock connectors need nothing.** Demo Email, Demo Chat, Demo Calendar, and Demo Drive are real connectors that serve a deterministic narrative dataset — they support full and incremental syncs, search, and even action execution (so the approval flow is testable end to end).

**Google sources connect with OAuth buttons.** With a Google OAuth client configured (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`), Gmail, Google Drive, and Google Calendar each get a **Connect with Google** button in Settings → Connected Sources: a per-source consent flow that requests only that source's read-only scope, stores tokens encrypted at rest, refreshes them automatically, and supports Reconnect/Disconnect from the UI. The env-supplied `GOOGLE_REFRESH_TOKEN` remains as the advanced/headless path. Setup: [docs/auth.md](docs/auth.md).

The other real providers (Outlook, Teams, OneDrive, Slack, S3) are configured via env vars (the Sources page shows whether a connector is configured):

| Connector(s) | Required env |
| --- | --- |
| Gmail, Google Calendar, Google Drive | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (OAuth connect buttons) — or add `GOOGLE_REFRESH_TOKEN` for the env path |
| Outlook, Teams, OneDrive | `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `MS_REFRESH_TOKEN` |
| Slack | `SLACK_BOT_TOKEN` |
| S3 (source) | `JARVIS_SOURCE_S3_BUCKET`, `JARVIS_SOURCE_S3_REGION` |

See `docs/connectors.md` for per-provider setup details.

**Honesty note:** the real connector hooks are written against the current public API documentation of each provider (request shapes, auth flows, cursors) and have unit tests with mocked HTTP — but they have **not yet been exercised against live provider APIs**. Expect to debug the first real connection.

## Architecture overview

Ten subsystems, mapped to directories:

| # | Subsystem | Where |
| --- | --- | --- |
| 1 | Domain model + engines (entities, capability catalog, **scoring engine**, **digest planner**, **policy engine**, normalize/chunk) | `packages/core` |
| 2 | Persistence (Kysely; SQLite default, Postgres via `DATABASE_URL`) | `packages/db` |
| 3 | LLM abstraction (fetch-based adapters: `anthropic`, `gemini`, `openai_compatible`, `mock`; streaming, structured output, usage events) | `packages/llm` |
| 4 | Connectors (registry, mock connectors, real provider hooks) | `packages/connectors` |
| 5 | API server (Fastify 5, routes per `docs/api-contract.md`, cookie auth) | `apps/server/src/routes` |
| 6 | Services (ingestion, scoring, digest, assistant, retrieval, indexing, memory, feedback, uploads, storage, settings, secrets) | `apps/server/src/services` |
| 7 | Background worker (cron digests, due syncs, approval expiry — inline or standalone) | `apps/server/src/worker*.ts` |
| 8 | Actions + approvals (policy-gated agent actions, approval queue) | `core/policy` + `services/actions.ts` |
| 9 | Audit + observability (audit log, LLM call log — metadata only) | `services/audit.ts`, `services/llm-router.ts` |
| 10 | Web app (React 18, Vite, Tailwind, React Query) | `apps/web` |

Request flow:

```
                       ┌────────────────────────────────────────────────┐
                       │                 apps/web (React)               │
                       └────────────────────┬───────────────────────────┘
                                            │  /api (JSON + SSE)
                       ┌────────────────────▼───────────────────────────┐
                       │            apps/server (Fastify 5)             │
                       │  routes → services                             │
                       └──┬──────────────┬──────────────┬───────────────┘
                          │              │              │
            ┌─────────────▼───┐  ┌───────▼────────┐  ┌──▼──────────────┐
            │ ingestion/sync  │  │ assistant/chat │  │ actions/policy  │
            │ connectors ────►│  │ retrieval +    │  │ evaluatePolicy →│
            │ normalize →     │  │ context → LLM  │  │ auto-approve /  │
            │ score → index   │  │ router (or     │  │ approval queue →│
            │                 │  │ mock/demo)     │  │ connector action│
            └───────┬─────────┘  └───────┬────────┘  └──┬──────────────┘
                    │                    │              │
                    ▼                    ▼              ▼
            ┌───────────────────────────────────────────────────────────┐
            │   packages/db — SQLite or Postgres (one portable schema)  │
            └───────────────────────────────────────────────────────────┘

   worker loop (in-process or standalone): scheduled digests · due syncs · approval expiry
```

Data model highlights:

- **Normalized `SourceItem`**: every connector — Gmail or mock — produces the same shape (title, body/snippet, sender and participants as `PersonRef`s, timestamps, due/start times, labels), so scoring, search, and the UI never special-case a provider.
- **Provenance everywhere**: items keep their provider, external ref, and URL; digest items and citations link back to source items; memories record where they came from.
- **Portable schema**: ISO-8601 text timestamps, integer booleans, JSON-as-text columns — the single Kysely schema runs unchanged on SQLite and Postgres (camelCase in code, snake_case in the database).
- **Retrieval layer**: text is chunked into `retrieval_chunks`; embeddings are stored separately and are strictly optional — keyword search works without them.

## Permission model

Jarvis's agency is governed by a single capability catalog (`packages/core/src/capabilities.ts`). Each capability has a plain-language label, a risk level, and a default effect:

- **Read & analyze** (read sources, search, summarize, classify, recommend) — *auto-approved*. This is Jarvis's day job.
- **Local create** (internal tasks, notes, local drafts, memories, preference updates) — *auto-approved*. Nothing leaves Jarvis.
- **External create** (send email, reply, calendar invites, chat posts, file sharing/upload) — *ask first*. Other people would see these.
- **Modify & destructive** (edit calendar events, modify mailboxes, delete anything, change permissions) — *ask first*, flagged medium to critical risk.

You can override any capability in **Settings → Permissions**: *Allowed automatically*, *Ask me first*, or *Never allow* (auto-approving an externally visible capability asks you to confirm). Pending requests land in the **Approvals** queue with a full preview of exactly what would happen, the reason, the target account, and a risk badge. Approving can optionally set **Always allow** for that capability; denied actions never execute; pending approvals expire after 7 days. Every proposal, decision, execution, and expiry is written to the audit log.

## Memory model

Jarvis separates what you *told* her from what she *guessed*:

- **Explicit** memories ("you told Jarvis") are ones you add or edit yourself.
- **Inferred** memories carry a confidence percentage and come from conversation phrasing like "always", "never", "prefer", "from now on", "remember that".
- **Feedback-derived** entries come from your priority feedback.

The Memory page shows everything, grouped by kind (preferences, facts, people, projects, behaviors, instructions). You can edit or delete any single entry, toggle individual entries off, export everything as JSON, or disable memory entirely with one switch — Jarvis stops reading *and* writing memories while it's off.

## Self-learning

On top of the memory notebook, Jarvis continuously **learns how you work** — from repeated behavior (who you answer fast, how you write to whom, what you approve), from your feedback, from your edits to AI drafts, and from explicit commands ("keep summaries short"). Learned preferences are tendencies with confidence scores, evidence trails, and per-context scope (terse with the team can coexist with warm to clients); they decay when not reinforced, and they personalize chat, drafting, and the daily debrief — always with a visible "why". The **Learned Preferences** page shows everything with its evidence; you can confirm, pin, edit, mark wrong, or delete any of it, and sensitive attributes (health, politics, religion, and similar) are never learned at all. Grounded in mainstream behavioral science — see [docs/self-learning.md](./docs/self-learning.md) and [docs/self_learning_psychology_foundation.md](./docs/self_learning_psychology_foundation.md).

## Daily debrief pipeline

Deterministic rules first, LLM polish second:

1. **Rescore** — recent items are scored by the rules engine in `packages/core/src/scoring`. Every rule that fires appends a weighted signal: sender importance (VIP +30), active project match (+15), deadlines, escalation language, blocking others, overdue (+45), meeting proximity, staleness, your past feedback (±10–15), topic preferences, and more. An optional LLM refinement is clamped to ±15 so the rules stay in charge.
2. **Plan** — the deterministic planner assigns each candidate to exactly one section, in priority order: Meetings Needing Prep, Risks & Blockers, Most Urgent, Most Important, Missed or Ignored, Unresolved Follow-ups, High-Effort Work, Worth Reading.
3. **Narrate** — if a model is routed to the `digest` task, it writes the summary and "Suggested plan for today" in a calm chief-of-staff voice; otherwise a rule-based markdown fallback is used (the digest header shows which, via the model badge).
4. **Schedule** — the worker runs the digest on a cron schedule (default `0 7 * * *`), editable in **Settings → Digest Schedule** with presets or a custom cron expression. Regenerating never overwrites: old versions stay in Digest History, linked via `supersedesDigestId`.

## Cloud deployment

The `Dockerfile` builds a single image containing the API server (which serves the web bundle), and the same image runs the worker with a different command:

```bash
docker build -t jarvis .
docker run -d -p 3001:3001 -v jarvis-data:/data \
  -e JARVIS_SECRET="$(openssl rand -hex 32)" \
  -e JARVIS_AUTH_MODE=password \
  -e JARVIS_OWNER_EMAIL=you@example.com \
  -e JARVIS_OWNER_PASSWORD='a-strong-password' \
  jarvis

# dedicated worker (same image, same env)
docker run -d -v jarvis-data:/data -e JARVIS_SECRET=... \
  jarvis pnpm --filter @jarvis/server worker
```

Checklist for anything beyond your own machine:

- **`JARVIS_SECRET`** — set a long random value. It signs sessions and encrypts stored API keys; the dev fallback logs a warning and is not safe.
- **Auth** — `JARVIS_AUTH_MODE=password` plus `JARVIS_OWNER_EMAIL` / `JARVIS_OWNER_PASSWORD`. The default `local` mode signs in anyone who can reach the server. Password mode also enables self-service registration (`JARVIS_ALLOW_SIGNUP`) and, with provider credentials set, Google / Facebook / Apple login — see [docs/auth.md](docs/auth.md).
- **Public URL** — set `JARVIS_PUBLIC_URL` to the externally visible URL (and `JARVIS_COOKIE_SECURE=true` behind HTTPS); OAuth redirect URIs are built from it.
- **Database** — set `DATABASE_URL` to a managed Postgres for anything you care about; migrations run automatically on start.
- **Uploads** — `JARVIS_STORAGE_DRIVER=s3` with `JARVIS_S3_BUCKET`, `JARVIS_S3_REGION`, AWS credentials, and optionally `JARVIS_S3_ENDPOINT` for MinIO/R2.
- **Scaling** — run the worker as a separate process/container and set `JARVIS_INLINE_WORKER=false` on the API so scheduled jobs run in exactly one place.
- **Secrets** — provide all keys via env (or your platform's secret manager) and reference them by env var name in provider configs; nothing sensitive needs to live in the database.

## Testing

```bash
pnpm test        # vitest across every package
pnpm typecheck   # tsc --noEmit across the workspace
pnpm lint        # eslint
```

The suite covers the core engines (scoring, digest planner, policy evaluation, normalization, chunking), the database layer on SQLite, all four LLM adapters (mocked HTTP), the connector registry and mock connectors end to end plus the Gmail/Slack/S3 hooks against mocked HTTP, the server routes and services, and the web pages (Testing Library + jsdom).

## Known limitations

Honesty over polish:

- **Real connectors are untested against live APIs.** The Gmail/Google/Microsoft/Slack/S3 hooks follow current public API docs and pass mocked-HTTP tests, but nobody has run them against a live account yet.
- **Gmail syncs metadata + snippet only** (`format=metadata`), not full message bodies. Scoring and search work on subjects, headers, and snippets.
- **Semantic search requires an embedding provider.** Without one, search and retrieval are keyword-only (the UI labels the active mode).
- **Single workspace per deployment**, designed for one user. `password` mode protects access, but there is no multi-tenant isolation.
- **LLM-path citation mapping is heuristic**: the model is asked to cite `[n]` markers that map back to retrieved snippets; if it doesn't, Jarvis falls back to the top retrieved results. Demo-mode citations are exact.
- **OAuth flows are tested against mocks, not live providers.** Sign-in with Google/Facebook/Apple and the Google source-connect flows have full unit-test coverage with mocked provider endpoints, but Facebook and Apple in particular have never been run against the live services. Microsoft and Slack connectors still have no consent-flow UI — they take env-supplied tokens only.
- **OAuth-connected Google sources are read-only by scope.** The connect buttons request `gmail.readonly` / `drive.metadata.readonly` / `calendar.readonly`, so approval-gated sends/invites fail on those accounts; writes need the env-supplied refresh-token path with broader scopes.
- **The login rate limiter is per-process** (in-memory): N API replicas multiply the attempts an attacker gets before throttling.
- Keyword retrieval is a SQL scan tuned for personal-scale data, not a search cluster.
- **Digest greetings/dates use UTC.** The fallback debrief narrative formats times in UTC; users far from UTC may see "Good morning" at the wrong hour. The scheduled-digest cron also evaluates in the server's timezone.
- **Switching embedding providers needs a re-index.** Semantic search only matches vectors from the currently routed embedding model; chunks indexed under an older model are skipped until re-indexed (re-sync or re-upload).

## Repo map

```
apps/server        Fastify API + worker (routes, services, bootstrap, config)
apps/web           React UI (pages, components)
packages/core      domain model, scoring/digest/policy engines, capability catalog
packages/db        Kysely schema, migrations, SQLite/Postgres client
packages/llm       provider adapters, router-facing client, structured output
packages/connectors  mock + real source connectors, registry
docs/api-contract.md  the binding REST contract between server and web
docs/walkthrough.md   a 10-minute product tour
```

More documentation:

- [docs/architecture.md](docs/architecture.md) — subsystem map, data flows, data model
- [docs/auth.md](docs/auth.md) — login (password + Google/Facebook/Apple), sessions, Gmail/Drive/Calendar authorization, token storage, secret rotation
- [docs/connectors.md](docs/connectors.md) — per-provider setup (env vars, scopes, credentials)
- [docs/developer-guide.md](docs/developer-guide.md) — add a connector, add an LLM provider, test patterns
- [docs/deployment.md](docs/deployment.md) — local, Docker Compose, and cloud deployment
- [docs/walkthrough.md](docs/walkthrough.md) — 10-minute product tour

