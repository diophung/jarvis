# Connectors

A connector adapts one provider (Gmail, Slack, S3, the local mocks, …) to
Donna's normalized ingestion contract. This page documents every connector in
the default registry: what it reads, the exact env vars it needs, the
least-privilege scopes it requests, how syncs stay incremental, and which
write actions it can execute through the approval flow.

Related: [architecture.md](./architecture.md) for the ingestion pipeline,
[developer-guide.md](./developer-guide.md#how-to-add-a-connector) for writing
a new connector, [api-contract.md](./api-contract.md) for the Sources API.

## How connectors work

- Each connector implements the `Connector` interface
  (`packages/connectors/src/types.ts`): a static `descriptor`, `healthCheck`,
  paged `sync`, and optional `fetchItem` / `fetchAttachment` / `execute`.
- **Secrets never live in connector code or the database.** Connectors
  resolve credentials at call time through a `SecretResolver` (environment
  variables). Error messages and health checks name the missing env *vars*,
  never their values.
- Connecting a source is `POST /api/sources/accounts { provider }`. The
  catalog (`GET /api/sources/catalog`) reports `configured: true` when all of
  a connector's `requiredEnv` vars are set (mock connectors are always
  configured). Accounts whose env is missing are created with status
  `needs_auth`.
- **Incremental sync**: each connector returns an opaque cursor with every
  page; Donna persists it per account and passes it back on the next run.
  Cursor semantics are provider-specific (documented per connector below).
- **Writes only run through the approval flow.** `connector.execute` is only
  called by the actions service after a policy check / user approval — see
  the capability mapping table at the end.

## Status: structured but untested against live APIs

The mock connectors are fully tested and power demo mode. The **real**
connectors (Gmail, Google Calendar, Google Drive, Outlook, Teams, OneDrive,
Slack, S3) are *hooks*: their request/response structures follow each
provider's current public API documentation and are covered by unit tests
with mocked `fetch`, but **they have not been exercised against live
accounts**. Expect to validate them (and possibly fix field-level details)
against a real account before relying on them. Each source file carries the
same caveat in its header comment.

## Catalog

| Provider id | Category | Label | Required env | Write actions |
|---|---|---|---|---|
| `mock-email` | email | Demo Email | — | `send_email`, `reply_email` (simulated) |
| `mock-chat` | chat | Demo Chat | — | `post_message` (simulated) |
| `mock-calendar` | calendar | Demo Calendar | — | `create_event`, `update_event` (simulated) |
| `mock-storage` | storage | Demo Drive | — | — (read-only) |
| `gmail` | email | Gmail | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `send_email` |
| `google-calendar` | calendar | Google Calendar | same Google trio | `create_event` |
| `google-drive` | storage | Google Drive | same Google trio | — (read-only) |
| `outlook` | email | Microsoft Outlook | `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `MS_REFRESH_TOKEN` | `send_email` |
| `teams` | chat | Microsoft Teams | same Microsoft quad | — (read-only) |
| `onedrive` | storage | OneDrive | same Microsoft quad | — (read-only) |
| `slack` | chat | Slack | `SLACK_BOT_TOKEN` | `post_message` |
| `s3` | storage | AWS S3 | `DONNA_SOURCE_S3_BUCKET`, `DONNA_SOURCE_S3_REGION` (+ AWS credential chain) | — (read-only) |

## Mock connectors (demo mode)

All four serve `createDemoDataset(now)`
(`packages/connectors/src/demo/dataset.ts`) — a pure function that generates
a coherent workspace relative to "now", so demos always look fresh and the
same `now` always yields the identical dataset. The narrative: you are
**Alex Chen, VP Product at Meridian Labs**. The *Atlas Launch* is six days out
and high-stakes; the *Q3 Budget* needs your decision by Friday; the *Vendor
Migration* to CloudPier is blocked on a security review; a key customer
(Daniel Reyes, Northwind) sent an important email three days ago that got
buried; legal needs contract redlines signed off by tomorrow.

What each one produces:

- **`mock-email`** — Alex's inbox: escalations from the CEO (Sarah Okafor,
  VIP), the buried Northwind customer email, budget and legal threads,
  newsletters to ignore. Supports simulated `send_email` / `reply_email`
  (returns a fake external reference, never touches the network) and serves
  fake attachment content.
- **`mock-chat`** — Slack-style channels `#atlas-launch`, `#leadership`, and
  `#vendor-migration` with threaded messages from the demo cast. Simulated
  `post_message`.
- **`mock-calendar`** — Alex's calendar from yesterday through +7 days
  (launch readiness reviews, 1:1s, board prep). Simulated `create_event` /
  `update_event`.
- **`mock-storage`** — Meridian's shared drive: launch decks, contracts,
  runbooks, and a long strategy document (good for testing chunked retrieval).
  Read-only, with fake downloadable content.

Demo people (seeded into `people` with importance levels) and the three demo
projects are exported as `DEMO_PEOPLE` / `DEMO_PROJECTS` and seeded by
`bootstrap` on first boot.

Cursor semantics are real, not faked: a full sync pages with `offset:<n>`
cursors and finishes with `synced:<n>`; the first *incremental* sync after
that returns the dataset's 1–2 simulated "new arrivals", and the next returns
nothing. Tests (and anything needing determinism) can pin time via the
account setting `demoNow` (ISO string or epoch ms).

## Google: Gmail, Google Calendar, Google Drive

All three share one OAuth refresh-token flow (`google/google-auth.ts`) and the
same env vars:

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

Access tokens are exchanged at call time against
`https://oauth2.googleapis.com/token` and cached in memory until ~30 s before
expiry.

**Getting credentials** (one-time, summarized):

1. In Google Cloud Console, create a project and enable the APIs you need
   (Gmail API, Google Calendar API, Google Drive API).
2. Create an OAuth client (type "Web application") → this yields
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. Run the authorization-code flow once for the scopes below with
   `access_type=offline&prompt=consent` (e.g. via Google's OAuth 2.0
   Playground configured to use your own client, or a small script). Exchange
   the code for tokens and keep the `refresh_token` → `GOOGLE_REFRESH_TOKEN`.

Scopes requested (least privilege, from each descriptor):

| Connector | Scopes |
|---|---|
| `gmail` | `gmail.readonly`, `gmail.send` |
| `google-calendar` | `calendar.events` |
| `google-drive` | `drive.metadata.readonly` |

(Full URIs: `https://www.googleapis.com/auth/<scope>`.) If you only want
read-only behavior, omit `gmail.send` — sending will then fail at execute
time, but sync is unaffected.

**Sync semantics:**

- `gmail` — lists `users/me/messages` with a query filter. The first full
  sync uses `newer_than:30d -in:spam -in:trash` (override via account setting
  `gmailQuery`); incremental syncs derive a precise `after:<epoch seconds>`
  filter from the persisted max `internalDate`. Messages are fetched in
  `format=metadata` (headers + snippet — no full bodies).
- `google-calendar` — full sync lists primary-calendar events in a window
  (default 7 days back to 30 days ahead; override via settings
  `calendarTimeMin` / `calendarTimeMax`); incremental syncs use `updatedMin`
  from the persisted max `updated`. Cancelled events are skipped; `iCalUID`
  becomes the cross-source dedupe hint.
- `google-drive` — `files.list` ordered by `modifiedTime` (metadata only);
  incremental syncs filter `modifiedTime > '<cursor>'`.

**Writes:** `gmail` executes `send_email` (builds an RFC 822 message and
POSTs base64url to `messages/send`); `google-calendar` executes
`create_event` (`events.insert` on the primary calendar with title, start/end,
optional description and attendee emails).

## Microsoft: Outlook, Teams, OneDrive

All three share one Microsoft identity platform refresh-token flow
(`microsoft/ms-auth.ts`) against
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` (scope
`https://graph.microsoft.com/.default offline_access`), and the same env vars:

```
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=
MS_REFRESH_TOKEN=
```

**Getting credentials** (one-time, summarized):

1. Register an application in Microsoft Entra ID (Azure portal → App
   registrations). Note the application (client) id and directory (tenant) id.
2. Add a client secret → `MS_CLIENT_SECRET`.
3. Grant **delegated** Microsoft Graph permissions matching the scopes below
   (plus `offline_access`), with admin consent if your tenant requires it.
4. Run the auth-code flow once as the target user and keep the refresh token
   → `MS_REFRESH_TOKEN`.

Scopes requested:

| Connector | Scopes |
|---|---|
| `outlook` | `Mail.Read`, `Mail.Send` |
| `teams` | `Chat.Read` |
| `onedrive` | `Files.Read` |

**Sync semantics:**

- `outlook` — full sync: `GET /v1.0/me/messages` ordered by
  `receivedDateTime desc`, paging via `@odata.nextLink` stored in the cursor;
  incremental: `$filter=receivedDateTime gt <persisted max ISO>`.
- `teams` — lists `/me/chats` (up to 20), then pages messages per chat.
  Graph's chat-message listing has limited server-side filtering, so
  incremental syncs filter client-side on `createdDateTime > cursor`.
- `onedrive` — `GET /me/drive/root/delta`. The cursor *is* the Graph-issued
  `@odata.nextLink` / `@odata.deltaLink` URL, so incremental syncs resume
  exactly where the last snapshot finished. File metadata only.

**Writes:** `outlook` executes `send_email` via `POST /me/sendMail`. Teams
and OneDrive are read-only.

## Slack

```
SLACK_BOT_TOKEN=
```

**Getting credentials:** create a Slack app (api.slack.com/apps), add these
**bot token scopes** (from the descriptor — least privilege), install the app
to your workspace, and use the bot token (`xoxb-…`):

- `channels:read` — discover public channels
- `channels:history` — read channel messages
- `users:read`, `users:read.email` — resolve sender names/emails
- `chat:write` — post messages (only via the approval flow; omit if you want
  read-only)

**Sync semantics:** `conversations.list` discovers up to 20 public,
non-archived channels (or set the account setting `channelIds` to restrict
the set), then `conversations.history` per channel with `oldest=<cursor ts>`
for incremental syncs — the cursor is the highest Slack `ts` watermark seen.
Sender identities are resolved via `users.info` with an in-memory cache.
Only plain user messages are ingested (no subtypes like joins/edits).

**Writes:** `post_message` via `chat.postMessage` (channel + text).

## AWS S3 (source bucket)

```
DONNA_SOURCE_S3_BUCKET=
DONNA_SOURCE_S3_REGION=
```

Per-account overrides are also supported via account settings `bucket`,
`region`, and `prefix` (e.g. to index only one key prefix).

**Credentials** come from the standard AWS default provider chain
(`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars, shared config files,
or an attached IAM role) — Donna never stores them. Least-privilege IAM
policy for the identity Donna runs as:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR_BUCKET" },
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::YOUR_BUCKET/*" }
  ]
}
```

(`s3:ListBucket` authorizes the `ListObjectsV2` calls used for listing and
the health check; `s3:GetObject` covers object fetches.)

**Sync semantics:** `ListObjectsV2` with standard `ContinuationToken`
pagination. S3 cannot filter listings by modification time server-side, so
incremental runs list pages and filter client-side against the persisted max
`LastModified`. Folder placeholder keys are skipped; the object `ETag` is
used as a dedupe hint. Read-only — no write actions.

## Write actions and the approval flow

Connector `execute` is only reachable through the actions service, after the
policy engine has auto-approved the capability or the user has explicitly
approved a request. Capabilities map to connector action types as follows
(`apps/server/src/services/actions.ts`):

| Capability | Connector action | Supported by |
|---|---|---|
| `email.send` | `send_email` | `gmail`, `outlook`, `mock-email` |
| `email.reply` | `reply_email` | `mock-email` only |
| `calendar.create_invite` | `create_event` | `google-calendar`, `mock-calendar` |
| `calendar.update` | `update_event` | `mock-calendar` only |
| `chat.post` | `post_message` | `slack`, `mock-chat` |

All of these are `require_approval` by default (see `CAPABILITY_CATALOG` in
`packages/core/src/capabilities.ts`); a connector receiving an action type it
does not support returns a failure result rather than throwing.
