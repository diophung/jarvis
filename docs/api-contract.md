# Donna REST API contract (v1)

This is the binding contract between `apps/server` routes and the `apps/web`
client. Both sides must follow it exactly. All endpoints are JSON unless
noted, all are cookie-authenticated (session cookie set automatically in
local auth mode), and all paths are prefixed `/api`.

Conventions:
- Entities are returned in their `@donna/core` camelCase shapes with JSON
  fields parsed (e.g. `signals` is an array, not a string).
- Errors: `{ "error": { "code": string, "message": string } }` with proper status.
- Lists return `{ items: [...] }` plus optional metadata fields.
- Timestamps are ISO-8601 strings.

## Auth & profile
- `GET /api/me` → `{ user: User, workspace: Workspace, authMode: 'local'|'password' }`
  (in local mode this auto-creates + logs in the default user)
- `POST /api/auth/login` `{ email, password }` → `{ user }` (password mode)
- `POST /api/auth/logout` → `{ ok: true }`
- `PATCH /api/me` `{ name?, email? }` → `{ user }`

## Conversations & chat
- `GET /api/conversations` → `{ items: Conversation[] }` (most recent first, non-archived)
- `POST /api/conversations` `{ title? }` → `{ conversation }`
- `GET /api/conversations/:id` → `{ conversation, messages: Message[] }`
- `PATCH /api/conversations/:id` `{ title?, pinned?, archived? }` → `{ conversation }`
- `DELETE /api/conversations/:id` → `{ ok: true }`
- `POST /api/conversations/:id/messages` `{ content: string }` → **SSE stream** with events:
  - `delta` `{ text }` — incremental assistant text
  - `citations` `{ citations: Citation[] }`
  - `actions` `{ actions: SuggestedAction[] }`
  - `approval_created` `{ approvalId }`
  - `message` `{ message: Message }` — final persisted assistant message
  - `error` `{ error }`
  The user message is persisted before streaming; the stream ends after `message` or `error`.

## Digests (Daily Debrief)
- `GET /api/digests` → `{ items: Digest[] }` (newest first)
- `GET /api/digests/latest` → `{ digest: DigestWithItems | null }`
- `GET /api/digests/:id` → `{ digest: DigestWithItems }`
- `POST /api/digests/generate` `{ kind?: 'manual' }` → `{ digest: DigestWithItems }` (synchronous; regenerate passes `supersedesDigestId`)
- `GET /api/digests/schedule` → `{ schedule: { cron: string, enabled: boolean } }`
- `PUT /api/digests/schedule` `{ cron, enabled }` → same shape

## Tasks (prioritized items)
- `GET /api/tasks` → `{ items: TaskCandidate[] }` — query: `status` (default `open`), `category` (planning category), `limit`
- `POST /api/tasks/rescore` → `{ scored: number }` (re-runs prioritization)
- `PATCH /api/tasks/:id` `{ status?, deferredUntil? }` → `{ task }`
- `POST /api/feedback` `{ kind: FeedbackKind, sourceItemId?, taskCandidateId?, digestItemId?, note? }` → `{ ok: true }`

## Sources & sync
- `GET /api/sources/catalog` → `{ items: ConnectorDescriptor[] }` (all known connectors + whether their env is configured: each item also has `configured: boolean`)
- `GET /api/sources/accounts` → `{ items: SourceAccount[] }`
- `POST /api/sources/accounts` `{ provider, displayName? }` → `{ account }` (connect; mock providers always work)
- `DELETE /api/sources/accounts/:id` → `{ ok: true }` (disconnect)
- `POST /api/sources/accounts/:id/sync` `{ mode?: 'incremental'|'full' }` → `{ run: ConnectorRun }`
- `GET /api/sources/accounts/:id/runs` → `{ items: ConnectorRun[] }` (recent first)
- `GET /api/sources/items` → `{ items: SourceItem[] }` — query: `category`, `accountId`, `q`, `limit`, `before`
- `GET /api/sources/items/:id` → `{ item: SourceItem, attachments: SourceAttachment[] }`

## Uploads
- `POST /api/uploads` — multipart/form-data, field `file` → `{ file: UploadedFile }`
- `GET /api/uploads` → `{ items: UploadedFile[] }`
- `GET /api/uploads/:id` → `{ file: UploadedFile }`
- `GET /api/uploads/:id/text` → `{ text: string | null }`
- `DELETE /api/uploads/:id` → `{ ok: true }`

## Search
- `GET /api/search?q=...&types=source_item,uploaded_file&limit=20` →
  `{ results: SearchResult[], mode: 'keyword'|'semantic+keyword' }`

## Approvals & actions
- `GET /api/approvals?status=pending` → `{ items: ApprovalRequest[] }`
- `POST /api/approvals/:id/decide` `{ decision: 'approve'|'deny', note?, alwaysAllow? }` → `{ approval, action? }`
- `GET /api/actions` → `{ items: AgentAction[] }` — query `status`, `limit`

## Permissions
- `GET /api/policies/catalog` → `{ items: CapabilityDef[] }` (from @donna/core CAPABILITY_CATALOG)
- `GET /api/policies` → `{ items: PermissionPolicy[] }`
- `PUT /api/policies/:capability` `{ effect: 'auto_approve'|'require_approval'|'deny' }` → `{ policy }`
  (creates or updates the user rule for that capability; capability is URL-encoded)
- `DELETE /api/policies/:id` → `{ ok: true }` (revert to default)

## Memory
- `GET /api/memory` → `{ items: MemoryEntry[], enabled: boolean }`
- `POST /api/memory` `{ kind, content }` → `{ memory }`
- `PATCH /api/memory/:id` `{ content?, kind?, enabled? }` → `{ memory }`
- `DELETE /api/memory/:id` → `{ ok: true }`
- `GET /api/memory/export` → `{ items: MemoryEntry[] }` (download-friendly)
- `PUT /api/memory/settings` `{ enabled: boolean }` → `{ enabled }`

## Preferences
- `GET /api/preferences` → `{ items: UserPreference[] }`
- `PUT /api/preferences/:key` `{ value: unknown }` → `{ preference }` (kind 'explicit', origin 'user')
- `DELETE /api/preferences/:key` → `{ ok: true }`
  Well-known keys: `people.vip` (string[] emails), `topics.prioritize` (string[]),
  `topics.ignore` (string[]), `sources.prioritize` (string[] provider ids),
  `sources.ignore` (string[]), `workingHours` ({ start, end }), `digest.time`,
  `assistant.responseStyle` ('concise'|'detailed'), `planning.style` (string).

## LLM providers & routing
- `GET /api/llm/providers` → `{ items: LlmProviderConfigPublic[] }` — `apiKeyEncrypted` is
  NEVER returned; instead `hasStoredKey: boolean` and `apiKeyMasked: string | null`.
- `POST /api/llm/providers` `{ name, kind, baseUrl?, model, apiKey?, apiKeyEnv?, temperature?, maxTokens?, timeoutMs?, isLocal?, supportsEmbeddings?, embeddingModel? }` → `{ provider }`
  (`apiKey` plaintext is encrypted server-side and discarded)
- `PATCH /api/llm/providers/:id` (same fields plus `enabled: boolean`, all optional; `apiKey: null` clears stored key) → `{ provider }`
- `DELETE /api/llm/providers/:id` → `{ ok: true }`
- `POST /api/llm/providers/:id/health` → `{ ok, latencyMs, message, models? }`
- `GET /api/llm/providers/:id/models` → `{ models: string[] }`
- `GET /api/llm/routes` → `{ routes: Record<LlmTask, { providerConfigId, modelOverride } | null> }`
- `PUT /api/llm/routes/:task` `{ providerConfigId, modelOverride? }` → `{ route }`
- `GET /api/llm/status` → `{ demoMode: boolean, tasks: Record<LlmTask, LlmTaskStatus | null> }`
- `GET /api/llm/calls` → `{ items: LlmCallLog[] }` — query `limit`

## People & projects (priority context)
- `GET /api/people` → `{ items: Person[] }`
- `PATCH /api/people/:id` `{ importance?, notes? }` → `{ person }`
- `GET /api/projects` → `{ items: Project[] }`
- `POST /api/projects` `{ name, description?, priority?, keywords? }` → `{ project }`
- `PATCH /api/projects/:id` `{ name?, description?, status?, priority?, keywords? }` → `{ project }`

## Audit & system
- `GET /api/audit` → `{ items: AuditLog[] }` — query `limit`, `before`, `eventType`, `actor`
- `GET /api/settings` → `{ settings: Record<string, unknown> }` (app settings incl. sync interval)
- `PUT /api/settings/:key` `{ value }` → `{ ok: true }`
- `GET /api/system` → `{ version, dbDialect: 'sqlite'|'postgres', storageDriver: 'local'|'s3', authMode, demoSeed: boolean, dataDir }` (Deployment tab)
- `GET /api/health` → `{ ok: true }` (no auth)
