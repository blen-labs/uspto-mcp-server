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
- `BETTER_AUTH_SECRET`: a random secret of at least 32 characters. It also keys the access-token MAC and
  encrypts confidential-client secrets, so changing it forces every connection and confidential client to
  re-authorize (see [Bearer token rollout](#bearer-token-rollout) and [Secret rotation](#secret-rotation)).
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
  Bearer tokens are admitted by their authenticated format before any database lookup or shared
  budget (see [Bearer token admission](#bearer-token-admission)).
  Behind a proxy, set `USPTO_CLIENT_IP_HEADER` (Railway: `x-real-ip`). This server's own per-IP
  limits count an IPv6 client by its /64 (and an IPv4-mapped address as its IPv4); Better Auth's
  built-in limits still receive the raw address.
  At most 256 token checks run at once per address.
- **OAuth token locks.** `/oauth2/token` and `/oauth2/revoke` serialize per user (refresh,
  revoke) or per code (code exchange) with a transaction-scoped PostgreSQL advisory lock, so
  refresh rotation and replay invalidation never interleave across replicas. The lock follows
  the operation Better Auth runs: form-encoded bodies only (last value of a repeated field
  wins), revoke uses `token`, a refresh grant `refresh_token`, a code exchange `code`; a
  conflicting repeat of `grant_type` or that field is a 400 `invalid_request`. Requests with
  nothing to lock (client_credentials, missing fields, other media types) take no lock.
  Each address is limited in memory to 20 token requests a second (bursts of 600) before
  any lookup. The locks use a separate pool of `AUTH_LOCK_POOL_SIZE` connections per replica
  (default 10, 2 to 200) in addition to the main pool, so budget
  `replicas x (main pool + AUTH_LOCK_POOL_SIZE)` against PostgreSQL's `max_connections`. A
  waiting request holds one inside an open transaction (`idle in transaction`, 10 second
  `lock_timeout`): do not set a shorter `idle_in_transaction_session_timeout` on the role than
  that plus the slowest token response. A request that cannot get a lock or a connection in
  10 seconds is rolled back and answered 503 with `Retry-After: 5`; the client retries.
- Browser state-changing requests require same-origin JSON; cookies are HttpOnly
  and SameSite, Secure in production. Responses are non-cacheable.
- Audit rows record owner, actor, action (`credential.<kind>.saved` /
  `.deleted` / `credential.reencrypted`) and timestamp, never key material.

## Bearer token admission

Hosted connectors share a few egress IPs, so one client sending bad bearer tokens must not lock valid
users out of an address. Access tokens are issued in an authenticated format,
`at1.<kid>.<issued-at>.<24 random bytes>.<MAC>`: the MAC is an HMAC-SHA256 keyed from `BETTER_AUTH_SECRET`
(HKDF, separate per key ID) over the rest of the token. `/mcp/account` admits a token in this order:

1. A value without the `at1.` prefix, or with it and a wrong shape, unknown key ID or bad MAC is `401` with no database
   work, no flood allowance and no in-flight slot. Parsing is strict and the MAC is compared in constant time.
2. A MAC-valid token older than `issued-at + 15 minutes + 60 s` is `401` with no database work. The 60 s is
   clock skew for this cheap bound only; the database expiry stays authoritative and never gains the skew.
3. A digest whose completed database check was rejected (revoked, no row, wrong resource, disabled client,
   unverified user) is remembered for at most 60 s, a fixed time that hits never extend, and never beyond the
   admission bound of step 2. The cache holds 10,000 digests, never holds database errors or limit responses,
   and is per replica.
4. A digest whose own database check recently succeeded carries a "recently validated" marker, set or renewed
   by each such success (expiry 60 s from then), with the same cap at the admission bound and the same
   10,000-entry bound. It is a routing hint, not an authorization result: every request still runs its own
   database check, and a rejection deletes the marker.
5. Per digest and replica, one check runs at a time for an unknown digest and at most 16 for a marked one, and
   only running checks take shared in-flight slots (step 6). Further requests for the digest queue FIFO,
   holding no slot: up to 256 per digest and 4,096 overall, then `429` with `Retry-After` (a known cap: a cold
   replica serving more than 257 simultaneous first-use calls with one token refuses the excess). When a check
   finishes its permit passes directly to the oldest queued request (strict arrival order; a new request never
   overtakes the queue), each running its own fresh check. If the digest was rejected, or its admission bound
   passes, every queued request is answered `401` at once and the queue is released; if it succeeded, they
   proceed 16 at a time. A later rejection never renews an existing negative entry's expiry.
6. A running check takes an in-flight slot (256 per IP bucket) and the `mcp-ip:` flood guard (6,000 a minute),
   and every admitted request still does the full database check.

So one rejected digest that was never validated costs one lookup per replica while its entry is kept (a
restart or eviction costs one more). A token validated and then revoked holds at most 16 slots until its
first rejection is recorded, and none after, so it cannot starve other users of the address. Residual: N
distinct validated-then-revoked tokens can hold up to 16 x N slots, bounded by the in-flight cap and the flood
guard, and they need N real tokens. Revocation is never delayed (only rejections are cached), while a
re-enabled client is accepted again within 60 s. The per-IP in-flight cap and the flood guard remain shared by
everyone on an address: they are sized for connector traffic, and reaching them takes sustained load of real
tokens, but they are a capacity limit, not something this removes.

Queued requests wait without a shared slot but are not cancelled when their client disconnects; the queues are
bounded (256 per digest, 4,096 overall) and drain as checks finish.

Only tokens issued by this server's own OAuth provider go through these checks, and only on `/mcp/account`.
Everything else is unchanged: Better Auth's own `/api/auth/oauth2/userinfo` still looks the presented token
up by its digest and accepts any stored token (introspection and revocation take the token in the
request body); the anonymous `/mcp` endpoint reads no token and ignores any bearer value; the
base HTTP transport (`--http` without accounts) verifies OIDC/JWT bearer tokens by signature, issuer, audience
and scope with its own per-IP limit, or accepts requests without a token under `--insecure`; stdio has no
bearer tokens.

Only tokens in the authenticated format are accepted: a bearer token without the `at1.` prefix, including an
old-format token that is still stored, is refused at step 1 with `401` (no database work, no in-flight slot, no
flood allowance), so junk of any shape never touches the `mcp-ip:` allowance or the slots that valid users on a
shared address depend on. A client holding a token issued before the format was introduced refreshes once.

## Bearer token rollout

The old format was retired in two releases, with no timers: the change is code, so restarts never reopen it and
every replica runs one rule.

- **Release 1 (dual-accept)** issued `at1` tokens and still accepted the old format on a separate path.
  **Release 2** removed that path. It could ship only after release 1 had been fully deployed, with no rollback,
  for at least `accessTokenExpiresIn + skew` (15 minutes + 60 s), the longest an old-format token issued by the
  last old instance can still be valid. Refresh tokens are unaffected.
- **Rollback.** Rolling back release 2 to release 1 is safe, as is rolling back release 1 to the version before
  it: that version validates by database digest only, and `at1` tokens are opaque strings to it.
- **Changing `accessTokenExpiresIn`.** The admission bound uses the maximum lifetime of any token that may
  still be valid: when raising or lowering it, keep the larger value in the bound until tokens issued under
  the old setting have expired.

Deploy prerequisite: all replicas must share `BETTER_AUTH_SECRET` (they already must), because the MAC key
derives from it; a replica with a different secret refuses other replicas' tokens.

## Secret rotation

Rotating `BETTER_AUTH_SECRET` is breaking, as it was before access-token MACs: confidential clients' secrets
are stored encrypted with it (`storeClientSecret: 'encrypted'`), so their refresh fails with `invalid_client`
until they re-register or re-authorize, and every outstanding access token stops verifying and is refused.
Plan a re-authorization of confidential clients and of all connections. A supported key-ring rotation (old and
new secrets side by side, key-ID overlap for the MAC, client-secret re-encryption) is not implemented. This is
separate from [Encryption rotation](#encryption-rotation), which covers the agency-key keyring and does not
rotate Better Auth's secret.

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
