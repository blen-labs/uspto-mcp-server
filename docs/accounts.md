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
  Behind a proxy, set `USPTO_CLIENT_IP_HEADER` (Railway: `x-real-ip`).
- Browser state-changing requests require same-origin JSON; cookies are HttpOnly
  and SameSite, Secure in production. Responses are non-cacheable.
- Audit rows record owner, actor, action (`credential.<kind>.saved` /
  `.deleted` / `credential.reencrypted`) and timestamp, never key material.

## Encryption rotation

Add the new key to `ENCRYPTION_KEYS_JSON`, retaining the old one, and set the new
active ID. `Store.rotateKeys(batchSize)` reencrypts stored credentials in locked
batches and records an audit event. Keep old keys until all rows and required
backups have been migrated or expired. Loss of an encryption key makes affected
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
