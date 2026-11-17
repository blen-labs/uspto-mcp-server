# Personal account authentication

`USPTO_AUTH_PROVIDER=accounts` (with `--http`) enables Google sign-in through
Better Auth, an OAuth provider for MCP clients, and a small React frontend
(`/account`, `/connect`, `/consent`). USPTO issues API keys to individuals — the
ODP key belongs to a USPTO.gov account with MFA and a one-time ID.me link
([Register for ODP access](https://data.uspto.gov/support/universal-registration)),
and USPTO says *"Do not share it with others"*
([Getting Started](https://data.uspto.gov/apis/getting-started)) — so each user
connects with their own keys, used only for that user's queries. Account mode
never uses an operator key for anyone.

Users visit `/account`, sign in with Google, and save:

- their **Open Data Portal key** (`odp`: patents, PTAB, petitions, office actions,
  bulk datasets), and/or
- their **TSDR key** (`tsdr`: trademark status and documents; a separate key).

Each key is checked against its own fixed USPTO endpoint before it replaces a
saved one. The check is a request made with that key, so it waits its turn in the
key's gate like any other use of the key, and a `429` pauses the key for at least
5 s (or `Retry-After`) (ODP: `GET https://api.uspto.gov/api/v1/patent/status-codes?offset=0&limit=1`
with `X-API-KEY`; TSDR: `GET https://tsdrapi.uspto.gov/ts/cd/casestatus/sn97123456/info`
with `USPTO-API-KEY`). Only a `2xx` accepts a key. `401`/`403` (and, for TSDR, `404`:
TSDR answers a bad key with 404, and its last-update endpoint answers 204 even with no
key, which is why it is not the probe) reject it; anything else is
reported as a failed check, and the existing key is kept. The account page returns
only connection status per kind, never a stored key. Users can replace or remove
each key independently.

Account mode serves two MCP endpoints, because MCP clients only start OAuth when
an endpoint answers 401:

| URL | Sign-in | Tools | USPTO keys |
| --- | --- | --- | --- |
| `/mcp` | none | `search_api`, `describe_schema` only | none — `execute` is not registered (a direct call is "Tool not found") |
| `/mcp/account` | Google, OAuth/PKCE | all three | the user's own saved keys |

`USPTO_API_KEY` / `USPTO_TSDR_API_KEY` are ignored in account mode (a warning is
logged if they are set). `/mcp` lets people explore the API documentation before
signing in; it ignores any bearer token, refuses browser requests from other
origins unless listed in `USPTO_ALLOWED_ORIGINS`, and is limited per client IP with
`USPTO_IP_RPS` and `USPTO_IP_BURST` (in memory per replica).

An MCP client connects to `/mcp/account`, discovers the authorization server,
registers with DCR or CIMD, and uses authorization code + S256 PKCE. Redirect URIs
must be HTTPS or loopback; a dynamic registration whose redirect URIs are all
loopback HTTP (`http://127.0.0.1:<port>/callback`, as desktop clients use) is
registered as `application_type: native` (RFC 8252) — Better Auth follows OpenID
DCR, which otherwise requires HTTPS for the default `web` type. After
sign-in, the Connect page lets the user save either or both keys, or continue with
the keys already saved. The Authorize page then shows the client, the callback
destination and which sources the saved keys enable, and offers Allow/Cancel, with
a link back to change keys.

## Portal API

All state-changing requests must be same-origin JSON from a verified session; no
request may name an owner.

| Request | Body | Effect |
| --- | --- | --- |
| `GET /api/portal/account` | — | `{ email, keys: { odp: { connected, updatedAt? }, tsdr: { ... } }, mcpUrl }` |
| `POST /api/portal/keys` | `{ apiKey?, tsdrApiKey? }` (at least one) | Checks every key present, then saves them; nothing is saved unless all checks pass. 5 checks/min per user. |
| `POST /api/portal/keys/delete` | `{ kind: 'odp' \| 'tsdr' }` | Removes that key. |
| `GET/POST /api/portal/connect` | `{ oauth_query, decision: 'continue' \| 'deny', apiKey?, tsdrApiKey? }` | The post-login Connect step. |
| `GET/POST /api/portal/consent` | `{ oauth_query, accept }` | The Authorize step; GET returns `keys: { odp, tsdr }` booleans. |

## Configuration

Use a **dedicated** PostgreSQL database. Set the following in the deployment
secret manager:

- `USPTO_AUTH_PROVIDER=accounts`
- `USPTO_PUBLIC_ORIGIN=https://uspto.mcp.blenlabs.com` (or your own origin)
- `DATABASE_URL` pointing to the dedicated database
- `BETTER_AUTH_SECRET`: a random secret of at least 32 characters
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `ENCRYPTION_KEYS_JSON`: a JSON object mapping key IDs to base64-encoded 32-byte keys
- `ENCRYPTION_ACTIVE_KEY_ID`: the key ID used for new writes, for example `v1`

Configure the Google OAuth web application's redirect URI as
`https://<your-origin>/api/auth/callback/google`, with the appropriate Google
consent-screen configuration.

Start with `pnpm build && pnpm start --http`. The build compiles the React frontend
to `dist/web`; `pnpm dev:web` rebuilds it while editing. Node 24 or 26 is required.
Account mode runs user code **only in the Deno sandbox** (a separate permissionless
process per execution), so Deno must be installed (the Docker image includes it);
without it `execute` reports `SandboxUnavailable`, and `--sandbox isolate` is
refused. Do not use `--insecure` in account mode; startup rejects that combination. Migrations
run before traffic is served, under a PostgreSQL advisory lock.

HTTP loopback origins are accepted only with `NODE_ENV=development` or `test`.
Production requires HTTPS and checks Host against the configured public origin.
The production server assumes one trusted proxy hop, as on Railway.

## Isolation and persistence

- Ownership comes only from the verified browser session or OAuth token's user.
- Keys are stored in `credentials`, primary key `(owner, kind)` with `kind` in
  (`odp`, `tsdr`), sealed with AES-256-GCM, random IVs, and the authenticated
  context `uspto-<kind>:<owner>` — a ciphertext cannot be opened for another user
  or as the other kind. Encryption keys stay outside PostgreSQL.
- OAuth access and refresh tokens are hashed; Google tokens and confidential
  client secrets are encrypted. Bearer access requires the right resource, the
  `uspto:read` scope, a current verified user, and an enabled client.
- Requests recheck the opaque token in PostgreSQL, so revocation takes effect on
  subsequent requests. Access tokens last 15 minutes; refresh tokens 30 days.
- An execution reads a user's key for a source the first time its code calls that
  source, and only that key: `odp`-only code never reads the TSDR key. Replacement
  or deletion affects the next execution.
- Signed-in calls always go to `https://api.uspto.gov` and
  `https://tsdrapi.uspto.gov`; `USPTO_ODP_BASE_URL` / `USPTO_TSDR_BASE_URL`
  overrides never apply to them, and process-level keys are never used.
- Each process caches account clients by a digest of owner + kind + key (up to 500,
  1 h TTL; each with a 100-item / 2 MiB response cache). Admission is per
  **credential**: one gate per digest of kind + key, shared by every cached client
  and every key check that uses the key (even if two accounts saved the same key),
  and looked up per request, so a key has **one request in flight per process**, as
  USPTO requires. Replicas do not coordinate this: run a single replica and avoid
  overlapping instances during deploys.
- Keys never enter the sandbox; error messages and results are scrubbed of the key
  (`[REDACTED]`), including keys spelled with JSON escapes.

## Limits

- `USPTO_ODP_RATE_PER_HOUR` / `USPTO_TSDR_RATE_PER_HOUR` cap each account per hour
  in PostgreSQL across replicas, counting every real upstream attempt after the
  response cache and gate admission.
- The per-execute budgets (`USPTO_ODP_MAX_CALLS_PER_EXECUTE`,
  `USPTO_TSDR_MAX_CALLS_PER_EXECUTE`) apply; the per-subject hourly quotas
  (`USPTO_*_SUBJECT_RATE_PER_HOUR`) are ignored in account mode.
- `USPTO_SUBJECT_DAILY_QUOTA` caps MCP requests per account per UTC day.
- `USPTO_MAX_CONCURRENT_EXECUTIONS` (8) and `USPTO_MAX_EXECUTIONS_PER_SUBJECT` (2)
  cap simultaneous executions per process and per account; a client that cancels or
  disconnects stops its execution and its in-flight USPTO calls.
- MCP request bodies are capped at 1 MiB.
- Fixed limits: 600 requests/min per IP for browser traffic, 6000/min per IP on
  `/mcp/account`, 600/min per user on `/mcp/account`, 5 key checks/min per user.
  Tokens that fail the check on `/mcp/account` are limited to 2/s per IP (bursts
  of 120, in memory per process); past that, requests get 429 before any
  database lookup.
  Behind a proxy, set `USPTO_CLIENT_IP_HEADER` (Railway: `x-real-ip`).
- Browser state-changing requests require same-origin JSON; cookies are HttpOnly
  and SameSite, Secure in production. Responses are non-cacheable.
- Audit rows record owner, actor, action (`credential.<kind>.saved` /
  `.deleted` / `credential.reencrypted`) and timestamp, never key material.

## Linked Claude billing

Optional, and off unless `USPTO_CLAUDE_LINK_CLIENT_ID` is set. A signed-in user can link
their own Claude Platform organization on `/account`, through Anthropic's
[linked billing](https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections)
(beta). This release only links and unlinks; nothing calls Claude yet.

**Console setup** (once, by an Admin of the operator's Claude organization):

1. An OAuth app with **Bill and link to organizations**, the `billing:attribution` and
   `offline_access` scopes, and the redirect URI `<origin>/api/portal/claude/callback`.
2. An issuer under Workload identity with an inline JWK set: the public half of an ES256
   key with a `kid`, issuer URL `<origin>/claude-link`, single-use tokens (JTI), at most
   1 hour lifetime. The private key goes in `USPTO_CLAUDE_LINK_SIGNING_JWK` and nowhere else.
3. The app's client authentication: that issuer, subject exactly `uspto-mcp-server:prod`
   (audience `https://auth.claude.com`, set by Anthropic).
4. An operator service account, a dedicated workspace it belongs to (the app's default
   workspace for connection tokens), and **operator-only tokenless authentication
   disabled**, so a customer is billed only with their own connection's token.
5. A federation rule from the same issuer, subject exactly `uspto-mcp-server:operator`,
   default audience, targeting the service account in that workspace with
   `workspace:developer`. The server uses it only to create user profiles.

**Settings** (all required once the client ID is set; startup names any that is missing):
`USPTO_CLAUDE_LINK_CLIENT_ID`, `USPTO_CLAUDE_LINK_SIGNING_JWK`,
`USPTO_CLAUDE_LINK_ORGANIZATION_ID`, `USPTO_CLAUDE_LINK_SERVICE_ACCOUNT_ID`,
`USPTO_CLAUDE_LINK_FEDERATION_RULE_ID` (the operator rule), `USPTO_CLAUDE_LINK_WORKSPACE_ID`.

**Flow.** `POST /api/portal/claude/link` creates the user's profile on first use (one per
account, kept after unlinking; Anthropic sees an opaque reference, never the email), sends
a pushed authorization request with PKCE, and returns the `auth.claude.com` URL. An Admin
or Billing member of the user's Claude organization approves and sets a monthly spend
limit. `GET /api/portal/claude/callback` consumes the state (single use, ten minutes) and
accepts it only for the same signed-in user and browser session that started it, before
anything is sent to Anthropic; the result returns to `/account?claude=<result>` as a fixed
code. A user who is already linked must unlink first (409); if two links started earlier both
finish, the newer connection replaces the older one, whose ID is stored with it until its
revocation succeeds. `POST /api/portal/claude/unlink` revokes by user profile (every
connection of the app on it, so a replaced one too) and then forgets the tokens; if
Anthropic can't be reached, nothing changes. `GET /api/portal/claude`
returns `{ enabled, linked, linkedAt? }`.

**Tokens.** Sealed in `claude_links` (AES-GCM, context `claude-link:<owner>`; pending
verifiers use `claude-link-pending:<owner>`). Every request to Anthropic carries a new
two-minute assertion with a unique `jti`. A refresh carries no `scope` and runs under a
per-owner PostgreSQL lock; the new pair is stored before use. Only a lost response (timeout,
network error, a body that never arrives) is repeated, once and at once, as Anthropic allows
within 30 seconds. `invalid_grant` forgets the connection (the user links again). A crash
between Anthropic's answer and the commit leaves the replaced refresh token, so the next
refresh ends the connection at Anthropic and the user links again; nothing stays billable. Audit actions:
`claude.link.created`, `.revoked`, `.expired`.

**Limits.** 5 link attempts per minute per user. A user who unlinks in their own Claude
Console still shows as linked here until the next refresh fails. While the app is in
testing, only its test users can link, with a spend limit of at most $50 a month.

## Encryption rotation

Add the new key to `ENCRYPTION_KEYS_JSON`, retaining the old one, and set the new
active ID. Then run, with the same account environment as the server:

```bash
node dist/bin.js --rotate-keys      # run it where the database is reachable, e.g. inside the deployed service
```

It re-encrypts stored credentials and linked Claude tokens in locked batches
(`Store.rotateAllKeys`) and records a `credential.reencrypted` (or
`claude.link.reencrypted`) audit event per row. A row that cannot be opened
(its key ID is no longer in `ENCRYPTION_KEYS_JSON`, or it is damaged) is skipped
and recorded as `credential.reencrypt_failed`; rotation continues with the next
row. The command logs how many rows rotated and which owner and kind failed, never
key material, and exits 1 if any row failed. Keep old keys until all rows and
required backups have been migrated or expired. Loss of an encryption key makes affected
credentials unrecoverable; users would need to save them again.

## Verification and rollout

`pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test` cover the transports
and sandbox. Account integration tests need Deno on PATH and `TEST_DATABASE_URL`
pointing to a disposable PostgreSQL database; each run creates and drops its own
schema. Locally, Docker works:

```bash
docker run -d --rm --name uspto-mcp-test-pg -e POSTGRES_PASSWORD=uspto-ci \
  -e POSTGRES_DB=uspto_test -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:uspto-ci@127.0.0.1:55432/uspto_test pnpm test test/accounts.spec.ts
```

The tests run real local HTTP requests, migrations, browser sessions, OAuth
registration/consent/PKCE/refresh/revocation (including loopback desktop-client
registration), and sandbox execution. Google identity is seeded by Better Auth's
test helper; USPTO is mocked. The account, connect and consent pages were also
reviewed in a browser against a local instance. The tests do **not** establish live
Google sign-in, a live USPTO key check through the portal, or hosted-client
interoperability — verify those in the deployed environment before enabling
account mode.
