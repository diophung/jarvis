# Deployment

Jarvis runs three ways: directly with pnpm (local), with Docker Compose
(single host), or as containers against managed Postgres + S3 (cloud). Every
env var below is defined in `apps/server/src/config.ts` and documented in
`.env.example`; all have safe local defaults, so a bare `pnpm dev` boots demo
mode with zero configuration.

Related: [architecture.md](./architecture.md) (worker design, demo mode),
[auth.md](./auth.md) (login, OAuth providers, redirect URIs, secret rotation),
[connectors.md](./connectors.md) (connector env vars),
[api-contract.md](./api-contract.md) (endpoints).

## Local (pnpm)

```bash
pnpm install
pnpm dev          # API on :3001 + web UI on :5173
```

The API serves `http://0.0.0.0:3001` (`JARVIS_PORT` / `JARVIS_HOST`); Vite
serves the UI on `:5173` and proxies `/api` to the API. The background worker
(scheduled digests, periodic syncs, approval expiry) runs in-process with the
API by default.

Data directory layout (`JARVIS_DATA_DIR`, default `./data`):

```
data/
  jarvis.db          # SQLite database (default when DATABASE_URL is unset)
  jarvis.db-wal      # SQLite write-ahead log
  jarvis.db-shm
  uploads/
    <workspaceId>/  # uploaded files (local storage driver)
```

SQLite is opened with `journal_mode = WAL` and `foreign_keys = ON`
(`packages/db/src/client.ts`). Migrations run automatically on every server
and worker start; `pnpm db:migrate` applies them standalone.

First boot (idempotent `bootstrap`): creates the owner user + workspace
(`JARVIS_OWNER_EMAIL` / `JARVIS_OWNER_NAME`), default settings (digest schedule
cron `0 7 * * *` enabled, 15-minute sync interval, memory on), seeds LLM
provider configs from any API-key env vars present, and — with
`JARVIS_DEMO_SEED=true` (the default) and no existing source accounts — seeds
the demo workspace and runs the initial sync. `pnpm seed:demo` forces the
same seeding logic on demand.

## Docker Compose

```bash
docker compose up --build
# UI + API on http://localhost:3001
```

The single image (see `Dockerfile`, `node:22-bookworm-slim`) contains the API
server, the worker entrypoint, and the built web bundle; the image sets
`JARVIS_PUBLIC_DIR=/app/apps/web/dist` so Fastify serves the UI same-origin
with an SPA fallback.

Services in `docker-compose.yml`:

| Service | What it runs | Notes |
|---|---|---|
| `jarvis` | API + UI on port 3001 | data in the `jarvis-data` volume (`JARVIS_DATA_DIR=/data`) |
| `worker` | `pnpm --filter @jarvis/server worker` | same image + volume; runs digests/syncs/expiry |
| `postgres` | Postgres 16 (profile `postgres`) | volume `jarvis-pg`, port 5432, db/user `jarvis`, password `POSTGRES_PASSWORD` (default `jarvis`) |
| `ollama` | Ollama (profile `ollama`) | volume `jarvis-ollama`, port 11434, for local inference |

Compose passes through from your shell/`.env`: `JARVIS_SECRET`,
`JARVIS_AUTH_MODE`, `JARVIS_DEMO_SEED`, the auth/OAuth vars
(`JARVIS_PUBLIC_URL`, `JARVIS_COOKIE_SECURE`, `JARVIS_TRUST_PROXY`,
`JARVIS_ALLOW_SIGNUP`, `JARVIS_TOKEN_ENCRYPTION_KEY`, `JARVIS_OWNER_EMAIL`,
`JARVIS_OWNER_NAME`, `JARVIS_OWNER_PASSWORD`, `JARVIS_WEB_ORIGIN`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`,
`FACEBOOK_CLIENT_SECRET`, `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`,
`APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`), `DATABASE_URL`, and the LLM vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`JARVIS_LOCAL_LLM_BASE_URL`, `JARVIS_LOCAL_LLM_MODEL`). Anything you leave
unset falls back to the same default the server would use on its own —
notably `JARVIS_TOKEN_ENCRYPTION_KEY` falls back to `JARVIS_SECRET`, and
`JARVIS_PUBLIC_URL` to `http://localhost:3001`. The `worker` service
additionally receives `JARVIS_TOKEN_ENCRYPTION_KEY` and
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, because it refreshes Google
source tokens during scheduled syncs.

**Worker split (`JARVIS_INLINE_WORKER`).** The API process runs its own
in-process scheduler unless you set `JARVIS_INLINE_WORKER=false`
(`apps/server/src/index.ts`). The compose file ships a dedicated `worker`
service and sets `JARVIS_INLINE_WORKER: "false"` on the `jarvis` service, so
scheduling runs in exactly one process.

Optional profiles:

```bash
# Postgres instead of SQLite
DATABASE_URL=postgres://jarvis:jarvis@postgres:5432/jarvis \
  docker compose --profile postgres up --build

# Local LLM via Ollama (then pull a model into the ollama container)
JARVIS_LOCAL_LLM_BASE_URL=http://ollama:11434/v1 \
JARVIS_LOCAL_LLM_MODEL=llama3.1:8b \
  docker compose --profile ollama up --build
```

## Cloud container deployment

Run the same image (API + optional separate worker) on any container
platform. The pieces to externalize:

**Database — managed Postgres.** Set
`DATABASE_URL=postgres://user:pass@host:5432/jarvis?sslmode=require`
(Aurora / AlloyDB / Cloud SQL / Neon). The schema is written in a portable
SQL subset and migrates automatically on boot. Pool size, connect/idle
timeouts, and the server-side statement timeout are tunable via
`JARVIS_DB_*` vars; pgvector is auto-detected and used for semantic search
when the extension is available. Readiness lives at `/api/health/ready`,
operational metrics at `/api/health/metrics`. Full architecture, scale
posture, partitioning DDL, and runbooks (including the SQLite→Postgres
backfill tool): [production-database.md](./production-database.md).

**Cache — optional Redis/Valkey.** Set `JARVIS_REDIS_URL` (ElastiCache,
Memorystore, Upstash) to share the hot-read cache across replicas; without
it each process uses a bounded in-memory cache. The cache is disposable —
an outage degrades to database reads behind a circuit breaker.

**Uploads — S3-compatible object storage.**

```
JARVIS_STORAGE_DRIVER=s3
JARVIS_S3_BUCKET=...
JARVIS_S3_REGION=...
# JARVIS_S3_ENDPOINT=...   # optional: MinIO / Cloudflare R2 (forces path-style)
```

AWS credentials come from the default provider chain
(`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or an IAM role). The identity
needs `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on the bucket's
objects. (This bucket is for Jarvis's own uploads — distinct from the
read-only S3 *source* connector, which uses `JARVIS_SOURCE_S3_*`; see
[connectors.md](./connectors.md).)

**Auth — password mode.** Local mode auto-logs-in a single user and is not
meant for anything reachable from the internet. For cloud:

```
JARVIS_AUTH_MODE=password
JARVIS_OWNER_EMAIL=you@example.com
JARVIS_OWNER_NAME=Your Name
JARVIS_OWNER_PASSWORD=...        # hashed (bcrypt) into the owner account on FIRST boot
JARVIS_COOKIE_SECURE=true        # Secure cookies — set it once you serve over HTTPS
# JARVIS_ALLOW_SIGNUP=false      # default true: self-service registration in password mode
```

Set `JARVIS_OWNER_PASSWORD` before the first boot — the owner row is created
once, and without it the owner has no password to log in with (recovery is
the `reset-password` CLI, see [auth.md](./auth.md#8-password-recovery-self-hosted)).
Sessions are DB-backed with a signed opaque cookie (`jarvis_session`, sliding
30-day expiry, revocable per device in Settings → Account & security).
Password mode also unlocks OAuth login (below). Full details:
[auth.md](./auth.md).

**Public URL & OAuth (`JARVIS_PUBLIC_URL`).** Behind a reverse proxy or any
non-localhost deployment, set `JARVIS_PUBLIC_URL` to the externally visible
base URL (e.g. `https://jarvis.example.com`) — OAuth redirect URIs for both
login and the Google source flows are built from it, and the server cannot
infer it from proxied requests. Optional provider credentials light up
"Sign in with …" buttons and the Google source connect buttons:

```
JARVIS_PUBLIC_URL=https://jarvis.example.com
GOOGLE_CLIENT_ID=...            # Google login + Gmail/Drive/Calendar connect
GOOGLE_CLIENT_SECRET=...
FACEBOOK_CLIENT_ID=...          # Facebook login
FACEBOOK_CLIENT_SECRET=...
APPLE_CLIENT_ID=...             # Apple login (Services ID) — HTTPS only
APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
# JARVIS_TOKEN_ENCRYPTION_KEY=...  # dedicated key for OAuth tokens at rest (default: JARVIS_SECRET)
```

Redirect-URI registration checklist (register the **exact** URLs at each
provider console; see [auth.md](./auth.md#10-redirect-uris-local-vs-cloud-and-troubleshooting)
for per-console steps and troubleshooting):

- Google (login): `<JARVIS_PUBLIC_URL>/api/auth/oauth/google/callback`
- Google (sources): `<JARVIS_PUBLIC_URL>/api/sources/oauth/google/callback`
- Facebook: `<JARVIS_PUBLIC_URL>/api/auth/oauth/facebook/callback`
- Apple: `<JARVIS_PUBLIC_URL>/api/auth/oauth/apple/callback`

**Apple requires HTTPS.** Apple rejects `http://`/localhost return URLs, and
its `form_post` callback depends on a `SameSite=None; Secure` state cookie —
so Apple login only works with an HTTPS `JARVIS_PUBLIC_URL` and
`JARVIS_COOKIE_SECURE=true`. Terminate TLS at your proxy/load balancer at
minimum.

**`JARVIS_SECRET` — required.** Signs session cookies and encrypts UI-entered
API keys at rest (AES-256-GCM with a key derived from it); it is also the
fallback key for stored OAuth tokens when `JARVIS_TOKEN_ENCRYPTION_KEY` is
unset. The server boots with a dev fallback but logs a warning; in production
set a long random value and keep it stable — rotating it signs everyone out
and orphans stored ciphertexts unless you re-encrypt them with
`src/scripts/rotate-token-key.ts` (`JARVIS_OLD_KEY=<previous>`; see
[auth.md](./auth.md#7-rotating-secrets)).

**Web origin / CORS.** When the UI is served by the API itself
(`JARVIS_PUBLIC_DIR`, set in the image), everything is same-origin and CORS is
moot. If you host the web bundle elsewhere, set `JARVIS_WEB_ORIGIN` to that
origin — it is the single allowed CORS origin (with credentials).

**Serving the built UI.** `JARVIS_PUBLIC_DIR` points the API at a built
`apps/web/dist`; Fastify serves it statically and falls back to `index.html`
for client-side routes (API 404s stay JSON). The Docker image builds the
bundle and sets this for you.

**Scaling.** The API is stateless apart from the DB and object storage, so
API replicas scale horizontally behind a load balancer (cookie auth needs no
sticky sessions; every replica must share the same `JARVIS_SECRET`,
`JARVIS_TOKEN_ENCRYPTION_KEY` if set, and `DATABASE_URL`). One caveat: the
failed-login rate limiter is in-memory per process, so N replicas multiply
the attempts before throttling. Set `JARVIS_INLINE_WORKER=false` on API replicas and run the
worker (`pnpm --filter @jarvis/server worker`) as its own service. Run
**exactly one** worker replica: its jobs (cron digests, due-account syncs,
approval expiry) coordinate through settings rows and timestamps, not
distributed locks, so concurrent workers can duplicate work.

**Health probes.** `GET /api/health` → `{ "ok": true }`, unauthenticated —
use it for liveness/readiness. `GET /api/system` (authenticated) reports
version, DB dialect, storage driver, and auth mode for debugging.

**LLM providers.** Either set key env vars (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `JARVIS_LOCAL_LLM_BASE_URL` +
`JARVIS_LOCAL_LLM_MODEL`) before first boot — bootstrap then creates provider
configs and task routes automatically — or configure providers later in
Settings → AI Providers. Without any, Jarvis runs in demo mode with a clear
UI banner.

## Secret management

- **Prefer env references over stored keys.** Connector credentials are
  *only* ever read from environment variables (`requiredEnv` on each
  connector descriptor) — they are never persisted in the database. LLM
  provider configs support the same pattern via `apiKeyEnv`: store the env
  var *name* (e.g. `ANTHROPIC_API_KEY`) and inject the value through your
  platform's secret manager. The env-named key always wins over a stored key.
- Keys entered through the UI are encrypted at rest
  (`api_key_encrypted`, AES-256-GCM keyed from `JARVIS_SECRET`) and never
  returned by the API — list endpoints expose only `hasStoredKey` and a
  masked preview.
- Logs and audit entries are content- and secret-free by design: LLM call
  logs record counts/latency only; audit metadata is redacted; auth headers
  and cookies are redacted from request logs.

## Backups

- **SQLite**: back up the whole `JARVIS_DATA_DIR` — `jarvis.db` plus its
  `-wal`/`-shm` siblings and `uploads/`. For a consistent copy of a live
  database use `sqlite3 data/jarvis.db ".backup backup.db"` (or stop the
  containers first); copying the bare `.db` file while writes are in flight
  can miss WAL contents.
- **Postgres**: standard `pg_dump` on the `DATABASE_URL` database, plus your
  managed provider's snapshots. Uploads then live in S3 — rely on bucket
  versioning/replication.
- Back up `JARVIS_SECRET` alongside the data: a database restore without the
  matching secret loses any UI-stored (encrypted) API keys, though env-based
  keys and everything else are unaffected.
