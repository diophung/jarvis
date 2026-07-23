# Authentication & OAuth

Everything about signing in to Jarvis and authorizing Jarvis to read your data:
how sessions work, how to configure Google / Facebook / Apple login, how the
per-source Gmail / Drive / Calendar authorization works, how tokens are stored,
and how to rotate secrets or recover a lost password.

Source of truth: `apps/server/src/auth.ts` (password auth, sessions, route
protection), `apps/server/src/routes/auth-oauth.ts` +
`apps/server/src/services/oauth/login-providers.ts` (OAuth login),
`apps/server/src/routes/source-oauth.ts` + `apps/server/src/services/tokens.ts`
(data-source authorization), `apps/server/src/config.ts` (env vars). Endpoint
shapes: [api-contract.md](./api-contract.md) "Auth & profile", "OAuth login",
and "Google source authorization".

## 1. How login works

### Auth modes

`JARVIS_AUTH_MODE` selects one of two modes (default `local`):

| Mode | Behavior | Use it for |
|---|---|---|
| `local` | The owner user is signed in automatically on first request — no login screen. A real DB session is still created and a cookie set. | Your own machine only. Anyone who can reach the server is signed in. |
| `password` | Email + password login, self-service registration (`JARVIS_ALLOW_SIGNUP`, default on), and any configured OAuth login providers. | Anything reachable by other people. |

In `password` mode the first owner account comes from `JARVIS_OWNER_EMAIL` /
`JARVIS_OWNER_NAME` / `JARVIS_OWNER_PASSWORD` on **first boot** (the password is
bcrypt-hashed into the owner row once — set it before the first start), or
users simply register at `/signup`. Every new user — registered or provisioned
via OAuth — gets their own workspace (`services/users.ts`).

### Passwords

- Hashing: bcrypt, cost 10 (`bcryptjs`).
- Policy (`validatePassword` in `auth.ts`): 10–200 characters, must differ
  from your email, and a small common-password blocklist.
- Login failures are always a generic 401 `invalid_credentials` ("Invalid
  email or password") — account existence is never revealed, and a dummy
  bcrypt compare keeps response timing uniform for unknown emails.
- Failed logins are rate limited: **5 failures per email+IP per 15 minutes**
  (429 `too_many_attempts`). Honest limitation: the counter is in-memory and
  **per process** — with N API replicas an attacker effectively gets N×5
  attempts. Fine for self-hosted single-instance; move to a shared store
  before scaling horizontally.
- Changing your password (`POST /api/auth/password`, or Settings → Account &
  security) requires the current password when one is set and **revokes every
  other session**.

### Sessions (DB-backed)

Sessions live in the `sessions` table (`services/sessions.ts`,
migration `0002_auth_oauth`):

- The cookie carries an **opaque random token** (32 bytes, base64url). The
  database stores only its **sha256 hash** — a leaked DB cannot be replayed
  as a session.
- **Sliding 30-day expiry**: activity refreshes `last_seen_at` (throttled to
  one write per minute) and extends the expiry whenever less than half the
  TTL (15 days) remains.
- **Revocation is a row delete**, effective immediately: logout, revoking a
  single session, "Sign out everywhere else" (Settings → Account & security →
  Sessions, which lists user agent + IP per session), and password changes
  all revoke server-side. The worker loop garbage-collects expired rows.

Cookie attributes (`jarvis_session`):

| Attribute | Value |
|---|---|
| `Path` | `/` |
| `HttpOnly` | yes |
| `SameSite` | `Lax` |
| `Secure` | `JARVIS_COOKIE_SECURE` (set `true` behind HTTPS) |
| Signed | yes, with `JARVIS_SECRET` (`@fastify/cookie`) |
| `Max-Age` | 30 days |

### What protects API routes

A global Fastify `onRequest` hook (`registerAuth` in `auth.ts`) rejects every
`/api/*` request without a valid session (401), except:

- `/api/health`, `/api/auth/login`, `/api/auth/register`, `/api/auth/methods`
- `/api/auth/oauth/*` (OAuth login start/callback — browser navigations that
  happen before a session exists)

Static assets (the built web UI) are public; all data lives behind `/api`. On
the web side, `RequireAuth` (`apps/web/src/lib/auth.tsx`, used in `App.tsx`)
redirects unauthenticated visits to `/signin?returnTo=<path>` — but that is
UX, not security; the API hook is the enforcement point.

## 2. Login vs. data-source authorization — two separate flows

This is the most important distinction in Jarvis's auth design:
**authentication** (who you are) and **data-source authorization** (what data
Jarvis may read) are related but separate. Signing in with Google does **not**
give Jarvis access to your Gmail, Drive, or Calendar — those are explicit,
per-source grants with their own consent screens and their own stored tokens.

**OAuth login** — proves identity, stores no provider tokens at all
(`auth_accounts` has no token columns by design):

```
Browser                      Jarvis API                         Provider
   │ GET /api/auth/oauth/google/start                              │
   ├────────────────────────────►│ set state cookie (10 min)       │
   │                             ├──302──► consent: "Sign in as…"  │
   │ ◄──────────── redirect back with code+state ──────────────────┤
   │ GET/POST /api/auth/oauth/google/callback                      │
   ├────────────────────────────►│ verify state (+PKCE/nonce)      │
   │                             │ exchange code, verify id_token  │
   │                             │ map profile → user (link rules) │
   │ ◄──302 returnTo + jarvis_session cookie (no provider tokens kept)
```

**Data-source authorization** — an *already signed-in* user grants Jarvis
least-privilege read access to one Google source; tokens are stored encrypted
and used server-side by the connector layer:

```
Browser (signed in)          Jarvis API                         Google
   │ GET /api/sources/oauth/google/gmail/start                     │
   ├────────────────────────────►│ state cookie bound to YOUR user │
   │                             ├──302──► consent: gmail.readonly │
   │ ◄──────────── redirect back with code+state ──────────────────┤
   │ GET /api/sources/oauth/google/callback                        │
   ├────────────────────────────►│ verify state + session match    │
   │                             │ exchange code (PKCE + secret)   │
   │                             │ encrypt tokens → oauth_tokens   │
   │                             │ create source account, kick sync│
   │ ◄──302 back to the app with ?connected=gmail                  │
```

Separate routes, separate state cookies (`jarvis_oauth_login` vs
`jarvis_oauth_source`), separate tables (`auth_accounts` vs `oauth_tokens`).
Google login deliberately requests **no offline access** — only the
per-source flow ever receives refresh tokens.

## 3. Configuring OAuth login

Providers light up automatically: `GET /api/auth/methods` lists a provider as
soon as its env vars are set, and the sign-in page renders the matching
"Continue with …" buttons. Redirect URIs are built from `JARVIS_PUBLIC_URL`
(default `http://localhost:3001`); register them **exactly** as shown.

> Honesty note: the Google login flow follows Google's OIDC documentation and
> the Facebook/Apple flows their respective docs, with full unit-test coverage
> against **mocked** provider endpoints. Facebook and Apple have **not been
> exercised against the live providers** — expect to shake out details on
> first real use.

### Google

Redirect URI to register: `<JARVIS_PUBLIC_URL>/api/auth/oauth/google/callback`

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs &
   Services → **OAuth consent screen**: configure the app (External), add
   yourself as a test user while in Testing status.
2. **Credentials → Create credentials → OAuth client ID**, type *Web
   application*; add the redirect URI above under *Authorized redirect URIs*.
3. Set the env vars:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

Login requests scopes `openid email profile` only, with PKCE (S256) and an
OIDC nonce; the `id_token` is verified against Google's JWKS (issuer,
audience, nonce) before any claim is trusted. The same client doubles as the
client for Gmail/Drive/Calendar authorization (section 5).

### Facebook

Redirect URI to register: `<JARVIS_PUBLIC_URL>/api/auth/oauth/facebook/callback`

1. [developers.facebook.com](https://developers.facebook.com/) → create an
   app → add the **Facebook Login** product.
2. Facebook Login → Settings → **Valid OAuth Redirect URIs**: add the URI
   above. While the app is in Development mode, only users with a role on the
   app can sign in.
3. App settings → Basic: copy the App ID / App Secret:

```
FACEBOOK_CLIENT_ID=<app id>
FACEBOOK_CLIENT_SECRET=<app secret>
```

Scopes: `email,public_profile`. Server-side Graph calls are signed with
`appsecret_proof` (HMAC-SHA256 of the access token). Facebook only returns an
email when it is confirmed on the account, so a returned email is treated as
verified; an account with no (confirmed) email fails login with `no_email`.

### Apple

Redirect URI to register: `<JARVIS_PUBLIC_URL>/api/auth/oauth/apple/callback`

Apple is the picky one — requirements that the others don't have:

- **HTTPS only.** Apple does not accept `http://` or `localhost` return URLs,
  and Jarvis's Apple flow itself requires HTTPS: Apple posts the callback as a
  cross-site `form_post`, so the state cookie must be `SameSite=None`, which
  browsers only accept (and send) as a `Secure` cookie. Set
  `JARVIS_COOKIE_SECURE=true` and serve Jarvis over HTTPS (for local testing,
  use an HTTPS tunnel and point `JARVIS_PUBLIC_URL` at it).
- **The client secret is not a string** — it is a short-lived **ES256 JWT**
  Jarvis mints per token call from your Sign in with Apple key.

Setup in the [Apple Developer portal](https://developer.apple.com/account/):

1. Certificates, Identifiers & Profiles → **Identifiers**: create an App ID,
   then a **Services ID** with "Sign in with Apple" enabled — the Services ID
   (e.g. `com.example.jarvis.web`) is your `APPLE_CLIENT_ID`. Configure it
   with your domain and the return URL above.
2. **Keys**: create a "Sign in with Apple" key, download the `.p8` file
   (one-time download), note the Key ID.
3. Your **Team ID** is in the top-right of the portal.

```
APPLE_CLIENT_ID=com.example.jarvis.web      # the Services ID, not the App ID
APPLE_TEAM_ID=ABCDE12345
APPLE_KEY_ID=ABC123DEFG
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----"
```

`APPLE_PRIVATE_KEY` is the PEM contents of the `.p8` file; `\n`-escaped
newlines are unescaped at config load, so a single-line env value works. All
four vars must be set for Apple to appear in `/api/auth/methods`.

Apple quirks Jarvis handles: the user's name arrives only on the **first**
login (`user` form field) and is never erased afterwards; `email_verified`
arrives as the string `"true"`; users may choose Apple's private relay email.

## 4. Account linking rules

When an OAuth callback resolves to a Jarvis user (`resolveOauthLogin` in
`services/oauth/login-providers.ts`):

| Situation at the callback | Outcome |
|---|---|
| This provider identity (`provider` + `providerAccountId`) is already linked to a user | Sign that user in. |
| Identity unknown, provider returned no email | Blocked — redirect to `/signin?error=no_email`. |
| Identity unknown, email matches an existing user, provider attests the email is **verified** | Identity is linked to that user and they are signed in (audited as `auth.oauth_linked`). |
| Identity unknown, email matches an existing user, email **not verified** | Blocked — `email_unverified`. An unverified provider email never attaches to an existing account (account-takeover protection). |
| Identity unknown, no matching user, signup allowed (`JARVIS_ALLOW_SIGNUP`, or local mode) | New user + workspace provisioned, identity linked, signed in. |
| Identity unknown, no matching user, signup disabled in password mode | Blocked — `signup_disabled`. |
| **Link flow** (`?link=1` from Settings → Account & security → Linked accounts; requires an active session) | Identity attaches to the *current* user regardless of email — an intentional, authenticated link. Fails with `already_linked` if it belongs to a different user. |
| Unlinking (`DELETE /api/auth/accounts/:id`) would leave no password **and** no other linked identity | Refused with 400 `last_login_method` — set a password first. |

## 5. Configuring Gmail / Drive / Calendar authorization

Uses the **same** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as Google login
— one Google OAuth client, two registered redirect URIs:

```
<JARVIS_PUBLIC_URL>/api/auth/oauth/google/callback        # login
<JARVIS_PUBLIC_URL>/api/sources/oauth/google/callback     # data sources
```

Enable the **Gmail API**, **Google Drive API**, and **Google Calendar API**
on the Cloud project, and add the scopes below to the OAuth consent screen.
Then connect from **Settings → Connected Sources** (the Sources page):
"Connect with Google" per source.

### Scopes (least privilege, read-only)

Per-source scopes from `SOURCE_SCOPES` in
`apps/server/src/routes/source-oauth.ts` — each request also includes
`openid email` so Jarvis can pin the grant to the granting Google account:

| Source | Scope requested | Jarvis can | Jarvis cannot |
|---|---|---|---|
| `gmail` | `https://www.googleapis.com/auth/gmail.readonly` | read subjects, senders, snippets | send or modify mail |
| `google-drive` | `https://www.googleapis.com/auth/drive.metadata.readonly` | see file names, owners, activity | open or download file contents |
| `google-calendar` | `https://www.googleapis.com/auth/calendar.readonly` | read events | create or change events |

Each source is authorized **independently** (connecting Calendar grants
nothing for Gmail), with `include_granted_scopes=true` for incremental
authorization, `access_type=offline` + `prompt=consent` (so a refresh token
is actually issued), PKCE (S256) on top of the confidential client secret,
and a signed state cookie bound to your session — a callback arriving on a
different session is rejected. If you untick the scope checkbox on Google's
consent screen, the flow fails cleanly with `scope_denied`.

Note the consequence for write actions: an OAuth-connected Gmail/Calendar has
**no send/write scope**, so approval-gated `send_email` / `create_event`
will be rejected by Google on these accounts. If you need writes, use the
env-based `GOOGLE_REFRESH_TOKEN` path with broader scopes — see
[connectors.md](./connectors.md#google-gmail-google-calendar-google-drive).

### Reconnect and `needs_reauth`

When Google permanently rejects a stored grant (refresh returns
`invalid_grant` / 400 / 401, or no usable refresh token exists), Jarvis marks
the grant `needs_reauth` and the source account `needs_auth`, records a
token-free error message, and writes a `source.token_refresh_failed` audit
event. The source card shows **"Needs reauthorization"** with a **Reconnect**
button that re-runs the same consent flow. Reauthorization must use the
**same Google account** as the original grant — a different account fails
with `wrong_account` (so a mailbox can never be silently swapped); disconnect
first if you really want to switch accounts.

### Disconnect

`DELETE /api/sources/accounts/:id` (the Disconnect button) revokes the grant
at Google (`https://oauth2.googleapis.com/revoke`, best effort — local
cleanup proceeds even if Google is unreachable), deletes the stored tokens
and the `oauth_tokens` row, removes the source account, and audits
`source.oauth_disconnected` + `connector.disconnected`.

## 6. Token storage & protection

- **Encrypted at rest**: access and refresh tokens in `oauth_tokens` are
  AES-256-GCM encrypted (`lib/crypto.ts`, format
  `v1:<iv>:<tag>:<ciphertext>`) with `JARVIS_TOKEN_ENCRYPTION_KEY`, falling
  back to `JARVIS_SECRET` when unset.
- **Never sent to the frontend**: the API exposes only `authKind` and
  `grantedScopes` on source accounts; `auth_accounts` has no token columns at
  all; raw tokens leave `services/tokens.ts` only as the in-memory value
  handed to the connector layer (`ConnectorContext.oauth.getAccessToken()`).
- **Never logged**: refresh failures record only the OAuth error *code*;
  audit metadata, redirects, and error messages are token-free; request logs
  redact `authorization` and `cookie` headers.
- **Refresh is single-flight** per grant: concurrent syncs share one
  refresh-token exchange, refreshed ~60 s before expiry; a rotated refresh
  token from Google replaces the stored one.
- **Failure marking**: permanent refresh failures flip the grant to
  `needs_reauth` (see above) instead of retry-looping.

## 7. Rotating secrets

### Encryption keys (`JARVIS_TOKEN_ENCRYPTION_KEY` / `JARVIS_SECRET`)

Stored ciphertexts do not survive a key change by themselves — rotate with
the re-encryption script:

```bash
# 1. set the NEW key(s) in the environment / .env
# 2. re-encrypt stored secrets from the old key:
JARVIS_OLD_KEY=<previous key> pnpm --filter @jarvis/server exec tsx src/scripts/rotate-token-key.ts
# 3. restart server + worker
```

The script re-encrypts `oauth_tokens.access_token_encrypted` /
`refresh_token_encrypted` under the current `JARVIS_TOKEN_ENCRYPTION_KEY`
(fallback `JARVIS_SECRET`) and `llm_provider_configs.api_key_encrypted` under
the current `JARVIS_SECRET`. It prints counts only — never secret material —
and exits non-zero if any row did not decrypt with `JARVIS_OLD_KEY` (those
rows are left untouched). If you skip the script after rotating, Google
grants flip to `needs_reauth` (one Reconnect click per source heals them) and
UI-stored LLM keys must be re-entered.

Also note: rotating `JARVIS_SECRET` invalidates every session **cookie**
(they are signed with it) — everyone signs in again.

### Sessions and passwords

- Changing a password (UI or API) revokes all *other* sessions of that user.
- The `reset-password` CLI (section 8) revokes **all** of the user's sessions.
- Any session can be revoked instantly from Settings → Account & security.

### Provider client secrets

Rotate `GOOGLE_CLIENT_SECRET` / `FACEBOOK_CLIENT_SECRET` in the provider
console, update the env var, restart. Existing grants and linked identities
survive — refresh tokens are bound to the client *ID*, not the secret. (A new
client ID, by contrast, invalidates every existing grant.) For Apple, revoke
the old Sign in with Apple key in the portal, create a new one, and update
`APPLE_KEY_ID` + `APPLE_PRIVATE_KEY`; client secrets are minted fresh per
token call, so nothing stored needs re-encryption.

## 8. Password recovery (self-hosted)

Jarvis sends no email, so there is no reset link — the `/forgot-password` page
says exactly this. Recovery is a CLI on the server (it enforces the same
password policy, then revokes all of the user's sessions):

```bash
pnpm --filter @jarvis/server exec tsx src/scripts/reset-password.ts you@example.com 'a-new-strong-password'
```

Run it where the server's env (`DATABASE_URL` / `JARVIS_DATA_DIR`) is visible
— e.g. `docker compose exec jarvis pnpm --filter @jarvis/server exec tsx
src/scripts/reset-password.ts ...` under Docker. The password comes from
argv and is never echoed or logged.

## 9. Extending

### Add a new OAuth login provider

Login providers are config-driven — one object per provider in
`LOGIN_PROVIDERS` (`apps/server/src/services/oauth/login-providers.ts`):

1. Add the id to `OAUTH_LOGIN_PROVIDERS` (`packages/core/src/enums.ts`) and
   its credential env vars to `apps/server/src/config.ts`.
2. Add a `LoginProviderConfig` entry: `authorizeUrl`, `tokenUrl`, `scopes`,
   `isConfigured()`, `authorizeParams()`, `fetchToken()`, and a `profile()`
   normalizer returning the common `OauthProfile`. Verify id_tokens with
   `jose` against the provider JWKS; set `emailVerified` only on a real
   provider attestation (it gates account linking — see section 4).
3. Extend the provider list in `GET /api/auth/methods` (`auth.ts`) and the
   `PROVIDER_LABELS` maps in `apps/web/src/pages/auth/shared.tsx` and
   `apps/web/src/pages/settings/SecurityTab.tsx`.

Routes, state/PKCE/nonce handling, linking rules, session creation, and audit
events all come from the shared machinery — no new routes needed.

### Add a new connected data source

For another **Google** source: add the source type to `GOOGLE_SOURCE_TYPES`
(`packages/core/src/enums.ts`), its scope/label/category to `SOURCE_SCOPES` /
`SOURCE_LABELS` / `SOURCE_CATEGORIES` in
`apps/server/src/routes/source-oauth.ts`, a connector with a descriptor in
`packages/connectors` that prefers `ctx.oauth.getAccessToken()` when present
(see `google/google-auth.ts` for the pattern), and UI labels in
`apps/web/src/pages/sources/google-oauth.ts`.

For a **non-Google** provider: the `oauth_tokens` table is already
provider-generic (`provider` + `source_type` columns), but
`services/tokens.ts` (token/revoke endpoints, refresh body) and
`routes/source-oauth.ts` are Google-specific today — add a parallel
provider module for the new token endpoints, then wire the connector the same
way. Connector authoring itself is covered in
[developer-guide.md](./developer-guide.md#how-to-add-a-connector).

## 10. Redirect URIs: local vs. cloud, and troubleshooting

`JARVIS_PUBLIC_URL` is the public base URL of the **API**; every redirect URI
is `<JARVIS_PUBLIC_URL>` + a fixed path. Unset, it defaults to
`http://localhost:<JARVIS_PORT>` (so `http://localhost:3001`).

| Deployment | `JARVIS_PUBLIC_URL` | Register at each provider |
|---|---|---|
| Local dev (`pnpm dev`) | unset (defaults to `http://localhost:3001`) | `http://localhost:3001/api/auth/oauth/<provider>/callback` and `http://localhost:3001/api/sources/oauth/google/callback` |
| Docker on your machine | `http://localhost:3001` (default works) | same as above |
| Cloud / reverse proxy at `https://jarvis.example.com` | `https://jarvis.example.com` (required — the server cannot guess its external URL) | `https://jarvis.example.com/api/auth/oauth/<provider>/callback` and `https://jarvis.example.com/api/sources/oauth/google/callback` |

Notes: register the API origin (`:3001` in dev), **not** the Vite dev server
(`:5173`) — after the callback the API redirects the browser back to the web
app (`JARVIS_WEB_ORIGIN` in split-origin dev, same-origin otherwise). A
trailing slash on `JARVIS_PUBLIC_URL` is stripped. Apple needs an HTTPS URL in
every row — `localhost` is never accepted (use an HTTPS tunnel locally).

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Google `Error 400: redirect_uri_mismatch` | The registered URI must match **exactly** (scheme, host, port, path). Set `JARVIS_PUBLIC_URL` to the URL in your browser's address bar and re-check the console entry. |
| Google `Error 403: access_denied` ("app not verified" / testing) | The consent screen is in *Testing* and you are not a test user — add yourself under OAuth consent screen → Test users. |
| Google sources flip to "Needs reauthorization" every ~7 days | Consent screen still in *Testing* publish status: Google expires its refresh tokens after 7 days. Publish the app (Gmail readonly is a restricted scope, so full verification may apply to non-personal use). |
| Redirected to `/signin?error=oauth_state_mismatch` (or `?sourceError=`) | The 10-minute state cookie expired on the consent screen, third-party cookies are blocked, or you started the flow on a different host than `JARVIS_PUBLIC_URL`. Retry promptly, from the public URL. |
| Apple login always fails state validation over HTTP | Expected: Apple's `form_post` callback needs a `SameSite=None; Secure` state cookie, which browsers drop on plain HTTP. HTTPS + `JARVIS_COOKIE_SECURE=true` only. |
| Apple `invalid_client` | `APPLE_CLIENT_ID` must be the **Services ID** (not the App ID); check `APPLE_TEAM_ID` / `APPLE_KEY_ID`, and that `APPLE_PRIVATE_KEY` kept its `BEGIN/END PRIVATE KEY` lines (use `\n` escapes in `.env`). |
| Facebook "URL Blocked" | Add the redirect URI under Facebook Login → Settings → Valid OAuth Redirect URIs; in Development mode only app-role users can sign in. |
| `?sourceError=scope_denied` | The scope checkbox was unticked on Google's consent screen — reconnect and leave the requested read-only scope checked. |
| `?sourceError=wrong_account` | Reconnect used a different Google account than the original grant. Use the original account, or disconnect the source first. |
| OAuth buttons missing from the sign-in page | The provider's env vars are incomplete (`GET /api/auth/methods` lists what the server considers configured). Apple needs all four `APPLE_*` vars. |
