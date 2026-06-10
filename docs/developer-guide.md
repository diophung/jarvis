# Developer guide

How to set up a dev environment, find your way around the monorepo, follow
the house conventions, and extend Donna with new connectors, LLM providers,
routes, and services.

Related: [architecture.md](./architecture.md) (system map),
[connectors.md](./connectors.md) (per-provider reference),
[api-contract.md](./api-contract.md) (REST contract),
[deployment.md](./deployment.md) (running in Docker / cloud).

## Dev setup

Requirements: Node >= 20 and pnpm 9 (`packageManager: pnpm@9.15.4` —
`corepack enable` gets you the right version).

```bash
pnpm install
pnpm dev          # API server (:3001, tsx watch) + web UI (:5173, Vite)
```

That's it. With no env vars set, Donna boots in demo mode: SQLite at
`./data/donna.db`, a seeded demo workspace (mock email/chat/calendar/storage
sources), local auto-login, and deterministic mock LLM responses. Copy
`.env.example` to `.env` to configure anything beyond that.

The Vite dev server proxies `/api` to `http://localhost:3001` (override with
`DONNA_API_ORIGIN`).

Other root scripts (see `package.json`):

```bash
pnpm dev:server     # API only
pnpm dev:web        # UI only
pnpm worker         # standalone background worker
pnpm build          # build all packages (server "build" is a typecheck; web builds the bundle)
pnpm test           # all test suites (vitest, pnpm -r --no-bail)
pnpm typecheck      # tsc --noEmit everywhere
pnpm lint           # eslint
pnpm db:migrate     # apply migrations and exit
pnpm seed:demo      # force demo seed (no-op when sources already exist)
```

## Monorepo layout

```
packages/core        domain model: entities, enums, ids, capabilities,
                     pure engines (scoring, digest planner, normalize/chunk, policy)
packages/db          Kysely schema + client (SQLite default, Postgres via DATABASE_URL),
                     static migrations
packages/llm         provider adapters (anthropic, gemini, openai_compatible, mock),
                     LlmClient (timeouts/retries/usage), structured output helpers
packages/connectors  Connector interface, registry, mock + real provider connectors,
                     demo dataset
apps/server          Fastify 5 API + worker: config, auth, routes/, services/, lib/
apps/web             React 18 + Vite + Tailwind UI
specs/               product spec
docs/                this documentation + api-contract.md
```

Dependency direction: `apps → packages`, `connectors/llm/db → core`, and
`core` depends on nothing internal. Keep pure logic (no clock, no IO) in
`packages/core`.

## Conventions

- **ESM with `.js` import extensions.** Every package is `"type": "module"`,
  and all relative imports use the `.js` extension even between `.ts` files
  (`import { GoogleAuth } from './google-auth.js'`). Code runs under `tsx`
  and vitest without a build step.
- **String unions, not TS enums.** All enums live in
  `packages/core/src/enums.ts` as `as const` arrays + derived union types so
  they serialize cleanly across DB, API, and UI.
- **Portable SQL.** One SQL subset for SQLite and Postgres: only
  TEXT/INTEGER/REAL columns, prefixed text ids (`newId('itm')` →
  `itm_x4k2…`), ISO-8601 text timestamps, integer `0|1` booleans. Migrations
  are statically imported in `packages/db/src/migrate.ts` (no FS scanning) —
  add `0002_*.ts` and register it there.
- **JSON-as-text.** Structured columns are JSON strings; always parse with
  `fromJson(text, fallback)` and write with `toJson(value)` from
  `@donna/core` — never raw `JSON.parse`. Field names are camelCase in code,
  snake_case in SQL (Kysely `CamelCasePlugin`).
- **Secrets** are referenced by env var *name* (`apiKeyEnv`,
  `SecretResolver`), or stored AES-256-GCM-encrypted when entered via the UI.
  Secret values never appear in logs, errors, or audit metadata.
- **Determinism**: engines in `core` take `now` as a parameter and never read
  the wall clock; adapters/services own time and IO.

## How to add a connector

Example: a hypothetical `linear` connector. Every connector declares one
category from `SOURCE_CATEGORIES` (`email | chat | calendar | storage |
upload`) — pick whichever your provider's items most resemble.

**1. Implement the `Connector` interface**
(`packages/connectors/src/types.ts`). Skeleton based on the real interface:

```ts
// packages/connectors/src/linear/linear.ts
import type { RawSourceItem } from '@donna/core';
import type {
  Connector, ConnectorAction, ConnectorActionResult, ConnectorContext,
  ConnectorDescriptor, ConnectorHealth, SyncPage, SyncRequest,
} from '../types.js';
import { parseJsonCursor } from '../util/parse.js';

export const LINEAR_REQUIRED_ENV = ['LINEAR_API_KEY'] as const;

interface LinearCursor extends Record<string, unknown> {
  sinceIso?: string;   // incremental watermark
  pageToken?: string;  // mid-run paging position
}

export class LinearConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'linear',          // stable id, used in source_accounts.provider
    category: 'chat',
    label: 'Linear',
    description: 'Linear issues and comments (read-only).',
    capabilities: ['read', 'list'],      // from CONNECTOR_CAPABILITIES in @donna/core
    scopes: ['read'],                    // least-privilege provider scopes/permissions
    requiredEnv: [...LINEAR_REQUIRED_ENV],
    local: false,                        // true only for mock/no-credential connectors
  };

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const key = ctx.secrets.get('LINEAR_API_KEY');
    if (!key) return { ok: false, message: 'not configured: missing env LINEAR_API_KEY' };
    // cheap authenticated request; report reachability, never the key value
    return { ok: true, message: 'Linear reachable' };
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const cursor = parseJsonCursor<LinearCursor>(req.cursor) ?? {};
    const sinceIso = req.mode === 'incremental' ? cursor.sinceIso : undefined;
    const items: RawSourceItem[] = []; // fetch one page, map to RawSourceItem
    // ... fetch(...) with Authorization header from ctx.secrets.get(...) ...
    const done = true; // no more pages in this run
    const nextCursor: LinearCursor = { sinceIso: /* new max timestamp */ sinceIso };
    return { items, nextCursor: JSON.stringify(nextCursor), done };
  }

  // Optional: only if the connector supports approval-gated writes.
  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    return { ok: false, detail: `linear does not support action '${action.type}'` };
  }
}
```

Rules the existing connectors follow:

- Constructing a connector never throws and never touches the network;
  credentials resolve lazily via `ctx.secrets` at call time.
- The cursor is an opaque string you fully own. Convention: a JSON object
  with a mid-run page token plus a high-water timestamp; when `done`, persist
  only the watermark so the next incremental run filters server-side (or
  client-side when the API can't).
- Map provider payloads to `RawSourceItem` (`packages/core/src/ingestion/types.ts`):
  `externalId`, `category`, `title`, ISO `timestamp`, plus optional body,
  sender/participants (`PersonRef`), thread id, labels, `dedupeHint`, and a
  `raw` metadata bag. Normalization (snippets, dedupe keys, hashes) is done
  for you downstream.

**2. Register it** in `createDefaultRegistry`
(`packages/connectors/src/registry.ts`):

```ts
registry.register(new LinearConnector());
```

Export the class from `packages/connectors/src/index.ts` if other packages
need it.

**3. Env via SecretResolver.** Add the env var(s) to `requiredEnv` and to
`.env.example`. The server's secrets service resolves them from
`process.env`; the catalog endpoint automatically reports
`configured: true/false` and the Sources UI shows the requirement.

**4. Tests with mocked fetch.** Follow
`packages/connectors/src/google/gmail.test.ts`: build a `ConnectorContext`
with `makeCtx({ secretValues: {...} })` (`test-helpers.ts`), stub the network
with `vi.stubGlobal('fetch', fetchMock)`, restore with
`vi.unstubAllGlobals()` in `afterEach`. Cover at minimum: health check
reports missing env by name; a full sync maps items correctly; an incremental
sync uses the cursor; cursors round-trip.

**5. Capabilities and scopes.** List only what the connector actually does in
`descriptor.capabilities` and the provider permissions it truly needs in
`descriptor.scopes` — both render in the Sources UI and in
[connectors.md](./connectors.md), which you should update. If you add a write
action, map its capability to the connector action type in
`connectorActionType` (`apps/server/src/services/actions.ts`) so the approval
flow can execute it.

## How to add an LLM provider

Adapters are pure fetch-based clients in `packages/llm/src/adapters/` — no
vendor SDKs.

1. **Implement `LlmProviderAdapter`** (`packages/llm/src/types.ts`):
   `kind`, `chat(params)`, `chatStream(params)` (an
   `AsyncGenerator<StreamEvent>`: zero or more `{type:'delta'}` then exactly
   one `{type:'done', result}` or `{type:'error'}`), `healthCheck()` (cheap
   reachability/auth check, ideally without burning tokens), and optionally
   `embed()` and `listModels()`. Export a `create<Name>Adapter(init: AdapterInit)`
   factory and a `DEFAULT_<NAME>_BASE_URL`.
2. **Map errors to `LlmError` codes.** Use the helpers in
   `adapters/shared.ts`: `httpStatusToLlmError` (401/403 → `auth`, 429 →
   `rate_limit`, 5xx → `server`, …) and `toLlmError` (aborts → `timeout`,
   network `TypeError` → `connection`). Correct codes matter because
   `LlmClient` only retries `connection`, `rate_limit`, `server`, and
   `timeout`.
3. **Add the kind** to `LLM_PROVIDER_KINDS` in
   `packages/core/src/enums.ts`.
4. **Wire the factory**: add a `case` to `createAdapter` and an entry to
   `KIND_DEFAULTS` (default base URL, embeddings support, local-by-default,
   UI label) in `packages/llm/src/factory.ts`. `KIND_DEFAULTS` drives the
   Settings → AI Providers UI and env bootstrap.
5. **Tests** with mocked fetch, following
   `adapters/openai-compatible.test.ts` / `anthropic.test.ts`: chat happy
   path, streaming event order, HTTP error → `LlmError` code mapping, and
   (if supported) embeddings.

You do not touch the router: once the kind exists, users can create a
provider config for it (API key via `apiKeyEnv` env reference or an encrypted
stored key) and route any task to it. `generateStructured`
(`packages/llm/src/structured.ts`) layers zod-validated JSON output on top of
any adapter via `jsonMode` — nothing provider-specific needed.

## How routes and services are wired

The pattern, end to end:

1. **Interface** — declare the service interface in
   `apps/server/src/context.ts` and add it to the `Services` container type.
2. **Factory** — implement `createXService(deps): XService` in
   `apps/server/src/services/x.ts`. Dependencies are passed explicitly
   (other services, `db`, `config`, `connectors`), never imported as
   singletons.
3. **Wiring** — instantiate it in `buildServices`
   (`apps/server/src/services/index.ts`) in dependency order.
4. **Routes** — add `apps/server/src/routes/x.ts` exporting
   `registerXRoutes(app: FastifyInstance, ctx: AppContext)`; validate
   request bodies with zod; throw `HttpError`s from `lib/http-errors.ts`
   (`badRequest`, `notFound`, …) for clean error envelopes. Register the
   module in `buildApp` (`apps/server/src/app.ts`).
5. **Contract** — document the endpoints in
   [api-contract.md](./api-contract.md) and mirror them in the web client
   (`apps/web/src/lib/api.ts`).

Auth is an `onRequest` hook (`apps/server/src/auth.ts`) that populates
`request.userId` / `request.workspaceId` from the signed session cookie (with
auto-login in local mode); routes just read those fields.

## Test patterns

All tests are vitest, colocated next to the code (`*.test.ts`). The full
suite (439 tests) runs with `pnpm test`; per package:
`pnpm --filter @donna/server test`.

- **DB tests** — `createTestDb()` (`apps/server/src/test/helpers.ts`) gives a
  fresh in-memory SQLite with the full schema; `seedWorkspace(db)` creates an
  owner user + workspace and returns their ids. The same portable schema runs
  on Postgres, so tests are dialect-faithful.
- **Route tests** — build a bare Fastify instance, stub auth with an
  `onRequest` hook, and register only the routes under test with a partial
  service container:

  ```ts
  app = fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  registerTaskRoutes(app, ctx);  // ctx.services: Partial<Services> cast
  ```

  Exercise endpoints with `app.inject({ method, url, payload })` — no real
  network listener.
- **LLM-dependent services** — stub the router with a `RoutedLlm` wrapping
  `createMockAdapter()` and `isMock: true` (see `stubLlm()` in
  `routes/tasks.test.ts`); the mock adapter is deterministic, so assertions
  are exact.
- **Connector tests** — `makeCtx()` + `vi.stubGlobal('fetch', …)` as
  described above; never hit the network.
- **Pure engines** (`packages/core`) — plain input/output assertions with a
  pinned `now`; no mocking needed.
- **Web tests** — vitest + Testing Library under jsdom
  (`apps/web/vite.config.ts` `test` block).
