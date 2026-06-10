You are Claude Code running with Fable, using maximum reasoning effort. You are acting as a senior full-stack engineer, security engineer, identity architect, and product-minded platform engineer.

Your task is to autonomously implement authentication and OAuth-based data-source authorization for Donna, a digital executive assistant.

Do not only propose the design. Inspect the repository, infer the current frontend, backend, database, routing, API, and deployment structure, then implement the feature end-to-end. If the repository is incomplete, create the necessary production-grade structure. Make pragmatic decisions, document them briefly, and continue.

Goal

Implement secure login for Donna using:

1. Email and password.
2. OAuth login with Google.
3. OAuth login with Facebook.
4. OAuth login with Apple ID.

Also implement OAuth authorization workflows so a logged-in user can connect:

1. Google Gmail.
2. Google Drive.
3. Google Calendar.

Important distinction: authentication and data-source authorization are related but separate. A user may sign in with Google, Facebook, Apple, or email/password. Separately, the user may authorize Donna to access Gmail, Google Drive, and Google Calendar. Do not assume Google login automatically grants Gmail, Drive, or Calendar access unless the required scopes were explicitly granted.

Implementation Principles

Start by inspecting the existing codebase. Identify the framework, auth library if any, database ORM, API style, session handling, environment management, and UI routing. Reuse existing patterns where reasonable.

If there is no existing auth system, implement a secure, standard solution. Prefer proven libraries over hand-rolled authentication. For a TypeScript/Next.js stack, consider Auth.js/NextAuth, Lucia, Passport, or a similar mature library depending on the repository. For other stacks, choose the most idiomatic secure option.

Do not hardcode secrets. All OAuth client IDs, client secrets, redirect URIs, JWT secrets, encryption keys, and provider configuration must come from environment variables or secure secret management.

Use secure defaults. Avoid storing raw access tokens in plain text. Encrypt provider tokens at rest. Never log secrets, authorization codes, access tokens, refresh tokens, ID tokens, passwords, or session cookies.

Authentication Requirements

Implement user login using email and password.

Email/password authentication must include:

1. User registration.
2. Login.
3. Logout.
4. Password hashing using a strong password hashing algorithm such as Argon2id or bcrypt.
5. Password validation rules.
6. Duplicate email handling.
7. Clear error messages that do not leak whether an account exists.
8. Session creation.
9. Session expiration.
10. Protected routes.
11. Authenticated API middleware.
12. Current-user endpoint or equivalent session hydration mechanism.

Implement OAuth login with:

1. Google.
2. Facebook.
3. Apple ID.

OAuth login must support:

1. Authorization code flow.
2. CSRF protection using state parameter.
3. PKCE where supported or appropriate.
4. Secure callback handling.
5. Account linking by verified email where safe.
6. Provider account table or equivalent mapping.
7. Login failure handling.
8. Redirect after login.
9. Logout behavior that clears local session state.
10. Provider profile normalization into a common user model.

The user model should support at minimum:

1. User ID.
2. Email.
3. Email verification status.
4. Display name.
5. Avatar URL.
6. Authentication provider accounts.
7. Created timestamp.
8. Updated timestamp.
9. Last login timestamp.

Google Data-Source Authorization Requirements

Implement separate connection flows for Gmail, Google Drive, and Google Calendar.

A logged-in Donna user should be able to go to Settings → Connected Sources and connect or disconnect:

1. Gmail.
2. Google Drive.
3. Google Calendar.

Each connection should use the OAuth authorization workflow and request only the minimum required scopes. Do not request broad scopes unless necessary.

Use incremental authorization where possible. The user should be able to connect Google Calendar without granting Gmail or Drive, and vice versa.

The Google connector model should store:

1. User ID.
2. Provider name.
3. Source type, such as gmail, google_drive, or google_calendar.
4. Granted scopes.
5. Access token, encrypted at rest.
6. Refresh token, encrypted at rest.
7. Token expiry.
8. Provider account ID.
9. Connection status.
10. Last successful sync timestamp.
11. Last error.
12. Created timestamp.
13. Updated timestamp.

Implement token refresh logic. If an access token expires, Donna should use the refresh token to obtain a new access token. If refresh fails, mark the connection as requiring reauthorization and surface this state clearly in the UI.

Implement disconnect logic. Disconnecting a source should remove or invalidate stored tokens for that source and mark the connection inactive. Where provider token revocation is supported, call the revocation endpoint.

Suggested Google Scopes

Use least-privilege scopes and make them easy to adjust.

For Gmail, start with read-only access unless the product already supports sending or modifying emails:

* https://www.googleapis.com/auth/gmail.readonly

If the product supports drafts later, keep draft scope separate and approval-gated:

* https://www.googleapis.com/auth/gmail.compose

For Google Drive, start with metadata and read-only file access where needed:

* https://www.googleapis.com/auth/drive.readonly

If possible, prefer narrower scopes such as file-specific access depending on the integration design.

For Google Calendar, start with read-only access:

* https://www.googleapis.com/auth/calendar.readonly

If later calendar creation is enabled, keep write scope separate and approval-gated:

* https://www.googleapis.com/auth/calendar.events

Do not request Gmail send, Drive write, or Calendar write by default.

UI Requirements

Add or update authentication pages:

1. Sign in page.
2. Sign up page.
3. Forgot password page if email/password auth supports it.
4. OAuth callback loading/error state.
5. Logout action.

The sign-in page should support:

1. Email/password login.
2. Continue with Google.
3. Continue with Facebook.
4. Continue with Apple.
5. Link to sign up.
6. Clear but safe error messages.

The sign-up page should support:

1. Email.
2. Password.
3. Display name if appropriate.
4. Terms or privacy acknowledgement placeholder if the product already has one.
5. Link back to sign in.

Add or update Settings → Connected Sources.

The Connected Sources page should show cards for:

1. Gmail.
2. Google Drive.
3. Google Calendar.

Each card should show:

1. Connection status.
2. Granted scopes.
3. Last sync time.
4. Last error if any.
5. Connect button.
6. Reconnect button when authorization has expired.
7. Disconnect button.
8. Brief explanation of what Donna can access.

Add or update Settings → Security or Account.

The account page should show:

1. Current login method.
2. Linked OAuth accounts.
3. Email verification status where applicable.
4. Session/logout controls.
5. Basic security information.

Backend/API Requirements

Implement backend routes or handlers for:

1. Email/password registration.
2. Email/password login.
3. Logout.
4. Current session or current user.
5. OAuth login initiation for Google, Facebook, and Apple.
6. OAuth callback handling for Google, Facebook, and Apple.
7. Google data-source authorization initiation for Gmail, Drive, and Calendar.
8. Google data-source OAuth callback handling.
9. List connected sources.
10. Disconnect connected source.
11. Refresh or reauthorize connected source.
12. Health check for connected source where feasible.

Protect all source-connection routes so only an authenticated user can connect, view, or disconnect personal data sources.

Use redirect URI configuration that works in both local and cloud deployments. Document required callback URLs.

Database Requirements

Create or update database schema/migrations for:

1. Users.
2. Auth accounts or provider accounts.
3. Sessions, if session storage is database-backed.
4. Verification tokens, if needed.
5. Password credentials.
6. Connected source accounts.
7. OAuth tokens, encrypted or stored using an encrypted token envelope.
8. Audit logs.

Avoid storing provider tokens directly on the user table. Store them in a dedicated connected-source or provider-token table with clear ownership and scope boundaries.

Security Requirements

Implement strong security practices:

1. Hash passwords with Argon2id or bcrypt.
2. Encrypt OAuth tokens at rest.
3. Use secure, httpOnly, sameSite cookies for session tokens where applicable.
4. Use CSRF protection for OAuth flows.
5. Validate OAuth state.
6. Use PKCE where supported.
7. Never expose tokens to the frontend.
8. Never log passwords or tokens.
9. Validate callback parameters.
10. Restrict redirect URLs to known safe destinations.
11. Use least-privilege OAuth scopes.
12. Support token revocation where provider APIs allow it.
13. Add audit logs for login, logout, OAuth linking, source connection, source disconnection, token refresh failure, and permission changes.
14. Ensure protected pages and APIs reject unauthenticated users.

Be careful with account linking. Only link OAuth accounts to an existing user when the provider email is verified and matches the authenticated user, or when the user is already logged in and intentionally links the account.

Integration with Donna’s Connector Layer

After Google Gmail, Drive, and Calendar are connected, expose the connection status and token retrieval mechanism to Donna’s connector layer.

Implement a secure server-side token access function such as:

* getGoogleAccessTokenForUser(userId, sourceType)
* refreshGoogleTokenIfNeeded(userId, sourceType)
* listConnectedSources(userId)
* disconnectSource(userId, sourceType)

Do not allow frontend code to directly access provider tokens.

If connector implementations already exist, wire them to use these secure token access functions. If connectors do not exist yet, create clean placeholder interfaces and at least one health-check or sample metadata call where practical.

Local and Cloud Configuration

Add environment variable examples for local development and cloud deployment.

At minimum, document variables such as:

* APP_URL
* AUTH_SECRET
* TOKEN_ENCRYPTION_KEY
* GOOGLE_CLIENT_ID
* GOOGLE_CLIENT_SECRET
* FACEBOOK_CLIENT_ID
* FACEBOOK_CLIENT_SECRET
* APPLE_CLIENT_ID
* APPLE_CLIENT_SECRET
* APPLE_TEAM_ID
* APPLE_KEY_ID
* APPLE_PRIVATE_KEY
* Database connection string
* Cookie/session configuration

Provide .env.example with placeholders.

Ensure local development works with localhost callback URLs. Ensure cloud deployment can use configured public callback URLs.

Testing Requirements

Add automated tests for:

1. Email/password registration.
2. Email/password login failure and success.
3. Password hashing behavior.
4. Protected route behavior.
5. OAuth state generation and validation.
6. OAuth callback success and failure handling.
7. Provider account linking.
8. Connected-source creation.
9. Connected-source disconnection.
10. Token encryption and decryption.
11. Token refresh path.
12. Authorization failure path.
13. API authorization middleware.
14. UI rendering for connected and disconnected sources.

Use mocks for provider OAuth endpoints where appropriate. Do not require real Google, Facebook, or Apple credentials for test execution.

Run lint, type-check, build, and test commands. If some commands cannot run because credentials or external dependencies are unavailable, document exactly what failed and why.

Documentation Requirements

Update or create documentation explaining:

1. How login works.
2. How OAuth login differs from Google data-source authorization.
3. How to configure Google, Facebook, and Apple login.
4. How to configure Gmail, Google Drive, and Google Calendar authorization.
5. Required OAuth redirect URIs for local and cloud.
6. Required scopes.
7. How tokens are stored and protected.
8. How to rotate secrets.
9. How to add a new OAuth provider.
10. How to add a new connected data source.

Definition of Done

The feature is complete when:

1. A user can sign up with email and password.
2. A user can sign in and sign out with email and password.
3. A user can sign in with Google, Facebook, or Apple ID.
4. Authenticated routes and APIs are protected.
5. A logged-in user can connect Gmail, Google Drive, and Google Calendar using OAuth authorization.
6. A user can see connected source status in Settings.
7. A user can disconnect each Google source.
8. Tokens are encrypted at rest and never exposed to the frontend.
9. OAuth state and callback handling are secure.
10. Audit logs record key auth and source-connection events.
11. Local and cloud environment setup is documented.
12. Tests, type-check, lint, and build have been run or failures are clearly documented.

At the end, provide a concise implementation summary. Include what was built, key files changed, schema changes, environment variables added, how to run locally, how to configure OAuth providers, what tests were run, and any limitations or follow-up recommendations.

Now begin by inspecting the repository, then implement authentication and OAuth-connected Google data sources autonomously.