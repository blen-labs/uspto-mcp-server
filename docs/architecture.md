# uspto-mcp-server architecture

## Overview

```
Transport (stdio | Streamable HTTP + OAuth | account mode)
    ↓
buildMcpServer  (search_api | describe_schema | execute)
    ↓
Supervisor  (sources + corpus + sandbox + execution limiter + budgets/quotas)
    ↓
SDK bindings  odp.*  (USPTO Open Data Portal, api.uspto.gov)
              tsdr.* (Trademark Status & Document Retrieval, tsdrapi.uspto.gov)
    ↓
HttpClient  (undici + key gate + size-bounded LRU + retries + caps + redaction)
    ↓
Upstream APIs
```

The server exposes exactly three MCP tools — the "code-mode" pattern:

| Tool              | Purpose |
|-------------------|---------|
| `search_api`      | BM25 over the per-source method + field corpora |
| `describe_schema` | Exact path lookup or namespace enumeration (`prefix`) |
| `execute`         | Run JavaScript (no type annotations) in a sandbox against `odp.*` / `tsdr.*` |

Each tool advertises a `title`, an `inputSchema` (from Zod 4's `z.toJSONSchema`,
so integer/min/max/length constraints and describe_schema's "exactly one of
`path` or `prefix`" rule are visible to clients), an `outputSchema`, and MCP tool
annotations: all three are `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`; only `execute` sets `openWorldHint: true`. Annotations are
hints for clients — enforcement is the sandbox and the method allowlist below.

Results are compact JSON text plus the same object as `structuredContent`. A
failed `execute` (thrown error, timeout, byte limit, `Busy`, …) is returned with
`isError: true` **and** the full envelope `{ ok: false, error: { name, message,
status? }, logs, durationMs }`, so the model can see what went wrong. Argument
validation failures and handler exceptions are `isError` too; an unknown tool
name is a JSON-RPC error.

## SDK bindings

Two sibling globals are always injected into the sandbox:

- **`odp.*`** — the USPTO Open Data Portal: `patents` (Patent File Wrapper search
  and per-application sub-resources), `ptab` (`proceedings`, `decisions`,
  `documents`, `appeals`, `interferences`), `petitions`, `officeActions` (the
  current Office Action Search API), `oa` (the legacy DSAPI office-action
  datasets: `text`, `citations`, `rejections`, `enrichedCitations`) and `bulk`
  (the bulk-dataset catalog).
- **`tsdr.*`** — trademark `status`, `multiStatus`, `documents`, `documentInfo`,
  `lastUpdate`.

The clients are implemented in TypeScript on the host
(`src/sdk/{odp,tsdr}-client.ts`) and exposed inside the sandbox as Proxy objects
that RPC back to the host. The host looks the dotted path up in the source's
explicit method table and invokes that method, which validates its arguments
and issues a parameterized HTTP request. Identifiers pass a grammar before they
reach a path: application numbers are normalized (`17/248,024` → `17248024`, PCT
forms), TSDR case ids must be `sn` + 8 digits, `rn`, `ir`, or `ref` + letters and
digits, and every other id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$` — so a
dot segment (`.`, `..`) or a separator can never change which endpoint is called.

All ODP searches share one JSON body (`q`, `filters`, `rangeFilters`, `sort`,
`fields`, `facets`, `pagination`); `toSearchBody` in `odp-client.ts` also accepts
shorthands (filter maps, `'field desc'` sort strings, `limit`/`offset`). The
bulk-dataset search is GET-only, so the same input is converted to query params
(at most one filter and one range filter: the GET multi-filter syntax is not
documented). The legacy `oa.*` datasets use form-encoded Lucene `criteria` with
`start`/`rows`.

ODP answers a query that matches nothing with **HTTP 404** and "No matching
records found" (observed live). For searches and list endpoints (`byTrial`,
`byAppeal`, `byInterference`, `statusCodes`, `bulk.search`) the client turns that
into `{ count: 0, <bag>: [] }`; get-by-id calls keep `NotFound`.

Downloads are deliberately not part of the surface: document PDFs, bulk files,
PTAB file URIs and `search/download` CSV exports are large binary payloads the
sandbox cannot use. The SDK returns their URLs.

### Source registry

Each binding is produced by a `Source` factory under `src/sdk/sources/`
(`odp.ts`, `tsdr.ts`); `getSources(cfg)` (`src/sdk/sources/index.ts`) assembles
the list, validates that each name is a safe JS identifier that does not collide
with a sandbox global, and hands the set to the supervisor and the sandbox global
injector. Adding a source is one factory plus one line here — the tools, sandbox
injection, and dispatch are all registry-driven.

Each factory returns a frozen `methods` table mapping dotted paths
(`'patents.search'`, `'ptab.decisions.byTrial'`, …) to public client methods. The
dispatcher resolves calls **only** as own properties of that table — it never
walks the client object — so the HTTP client, its cache, and inherited properties
are unreachable from the sandbox.

A `Source` reports `enabled` / `disabledReason`. Both sources are injected as
sandbox globals even when disabled (no `ReferenceError`); the dispatcher
(`src/sdk/runtime.ts`) resolves calls only for enabled sources, and a call to a
disabled source returns `SourceUnavailable` with its `disabledReason`, so one
missing key never takes the other source down.

## API keys

Both upstreams require a **personal** key. USPTO: *"There can only be one API Key
per account. Do not share it with others. It is an identifier unique to you."*
([Getting Started](https://data.uspto.gov/apis/getting-started)).

- **ODP** — `USPTO_API_KEY`, sent as `X-API-KEY` to `https://api.uspto.gov`.
  Requires a USPTO.gov account with multi-factor authentication (required for all
  ODP use since June 18, 2026) and a one-time ID.me identity link; the key is shown
  on the ODP **Manage API Key** page ([Register for ODP
  access](https://data.uspto.gov/support/universal-registration)). It "shouldn't
  expire if it is used at least one time per year". Keys of accounts that had not
  completed the profile fields required since August 18, 2026 were deactivated on
  October 8, 2026 (every call returns `403`) until the fields are completed and
  **Activate API Key** is clicked.
- **TSDR** — `USPTO_TSDR_API_KEY`, sent as `USPTO-API-KEY` to
  `https://tsdrapi.uspto.gov`. A separate key from the USPTO API Key Manager; the
  ODP key is not accepted there.

Each key is held **host-side** in a private `HttpClient` field and **never reaches
the sandbox**; it is not on the `Source` object, in logs, or in `JSON.stringify`
output, and the response cache key folds it into a digest. If an upstream echoes a
configured key back, `HttpClient` replaces it with `[REDACTED]` in the raw text, in
decoded JSON values and object keys, and in error messages — in every mode.
Without a key the source is disabled (above).

## Rate limits and guardrails

USPTO documents (https://data.uspto.gov/apis/api-rate-limits): **burst 1** — one
request in flight per key, concurrent requests get `429`; 4–15 requests per second
depending on the endpoint; 5,000,000 metadata calls and 1,200,000 file-wrapper
document calls per key per week, reset Sunday 00:00 UTC; and at least 5 seconds
before retrying after a `429`. TSDR's guidance is about 60 requests per minute. In
live testing a `429` also arrived with one request in flight at the documented
rate, so the server treats every `429` as a signal for the whole key.

The server enforces, per key:

- **Key gate** (`src/util/upstreamGate.ts`, built by `keyGate()` in the
  supervisor) — at most `USPTO_<SRC>_CONCURRENCY` (default `1`) requests in flight
  and `USPTO_<SRC>_RATE_PER_SEC` (ODP `4`, TSDR `1`) started per second, burst 1.
  Calls queue; a call still waiting after `USPTO_<SRC>_MAX_WAIT_MS` (default
  `30000`) fails with `RateLimited`. Cache hits and joined in-flight requests skip
  the gate. While callers are queued the gate's timer keeps the process alive; it
  is cleared when nobody waits.
- **429 handling** — a `429` pauses the key's gate for max(5 s, `Retry-After`),
  installed from the status and headers **before** the body is read and before the
  request's slot is released, so nothing queued slips through. The full
  `Retry-After` is honored for every caller (sanity cap 8 days, so a weekly-quota
  reset is respected); a gate paused for longer than a caller's wait fails that
  call fast with `RateLimited` and the wait time. The call that got the `429` is
  retried once only if the cooldown is 30 s or less. Network errors and `5xx` are
  retried with backoff (`USPTO_UPSTREAM_RETRIES`, default 2).
- **Hourly budget** — `USPTO_<SRC>_RATE_PER_HOUR` (ODP `5000`, TSDR `3000`) per
  configured key, charged for every real upstream attempt (retries included) after
  gate admission and just before the request is sent (`RateLimited`). In account
  mode it is per account, in PostgreSQL.
- **Per-execute budget** — `USPTO_ODP_MAX_CALLS_PER_EXECUTE` (`50`) and
  `USPTO_TSDR_MAX_CALLS_PER_EXECUTE` (`25`) upstream calls per `execute()` run
  (`CallBudgetExceeded`), enforced in `src/tools/execute.ts`.
- **Per-subject hourly quota** — HTTP only, `USPTO_<SRC>_SUBJECT_RATE_PER_HOUR`
  (ODP `1000`, TSDR `600`) per authenticated subject (`SubjectQuotaExceeded`).
  Under `--insecure` every caller is `anonymous` and shares one bucket; stdio has
  no subject and skips it; account mode uses its PostgreSQL limits instead.

For the hourly rates, `0` is **not** "unlimited" — `src/bin.ts` replaces values
below 1 with the default; to disable a source, unset its key.

All of this is in memory and per process: N replicas sharing one key look like N
concurrent clients to USPTO. Run one replica, and avoid deployments where an old
and a new instance serve at the same time.

## Executions

`execute` (`src/tools/execute.ts`):

1. refuses to start if the server is shutting down or the request was already
   cancelled;
2. admits the execution through the `ExecutionLimiter` — at most
   `USPTO_MAX_CONCURRENT_EXECUTIONS` (default 8) per server and
   `USPTO_MAX_EXECUTIONS_PER_SUBJECT` (default 2) per authenticated subject;
   over the cap it fails fast with `Busy`;
3. creates one `AbortController` per execution, aborted when the MCP request is
   cancelled or its client disconnects (`ctx.mcpReq.signal`), when the server shuts
   down, and when the execution ends. The signal reaches the sandbox and — through
   `AsyncLocalStorage` (`src/util/executionContext.ts`) — every `HttpClient` call,
   so queued calls leave the gate and in-flight requests are aborted. A request
   shared by several executions is aborted only when all of them have gone.

## Caching and responses

`HttpClient` (`src/util/httpClient.ts`) wraps `undici.request` with:

- An in-memory LRU (`USPTO_CACHE_TTL_MS`, default 10 min; `USPTO_CACHE_MAX_ITEMS`,
  default 1000; and at most 32 MiB of response text per client). Keys are method +
  URL + a digest of headers (including the API key) and body, so different keys
  never share responses. GETs are cacheable; search POSTs opt in with
  `cacheable: true`, keyed by their serialized body.
- In-flight sharing: identical cacheable requests already on the wire share one
  upstream call.
- A response cap (`USPTO_MAX_RESPONSE_BYTES`, default 8 MiB). gzip expansion is
  bounded too (`maxOutputLength`), so a small compressed body cannot inflate past
  the cap; larger bodies fail with `ResponseTooLarge`.
- Error mapping: `401`/`403` → `Unauthorized` (message never echoes the request),
  `404` → `NotFound` (or an empty result for no-match searches, above), `429` →
  `RateLimited`; USPTO JSON error details (`error`/`errorDetails`/`message`) are
  surfaced in the message for `4xx`. The HTTP status travels with the error into
  the sandbox (`e.status`).

## Sandbox

Every execution first passes an **AST preflight** (`src/sandbox/policy.ts`, Acorn)
that rejects `import` / `import()` / `eval` / `new Function` and references to
`process`, `globalThis`, `Buffer`, `Deno`, `fetch`, `Worker`, `WebSocket`, …, plus
`__proto__` / `constructor` / `prototype` member access. It is the first line of
defense, not the boundary.

Two runners:

- **`isolate`** — `isolated-vm` 7: a fresh V8 isolate per execution with a heap
  cap (`memoryMb`). Prebuilt binaries ship for Node 24 and 26 (darwin-arm64,
  linux-x64/arm64 glibc and musl, win32-x64), so no compiler is needed. The host
  owns a wall-clock deadline that starts before isolate setup; on expiry or abort
  the isolate is disposed (stopping running code and anything it awaits), and V8's
  own timeout remains as a second guard for synchronous loops.
- **`deno`** — `deno run --no-prompt --no-config --no-lock --no-remote --no-npm`
  of a fixed **supervisor** script with **no `--allow-*` flags** (no network,
  files, env, FFI or subprocesses) and a minimal environment. The supervisor file
  holds no user data; it is written once per process into a `0700` temporary
  directory and removed at exit. The supervisor generates a random token,
  announces it, receives the user code in a stdin message, and runs it in a module
  **Worker** whose `Deno`, `postMessage`, `fetch`, `Worker`, `WebSocket`, … globals
  are replaced with `undefined` and whose `console` posts log messages. Frames to
  the host are token-prefixed JSON lines; the worker never sees the token, and any
  other stdout bytes are treated as untrusted log text. The Node parent owns the
  deadline, kills the process group on every exit path, and resolves only after the
  child has exited (bounded wait), so an execution slot is never released while its
  process is alive. `memoryMb` is applied with `--v8-flags=--max-old-space-size`.

Both runners enforce the same **byte budgets** (`src/sandbox/limits.ts`), first
inside the sandbox — so over-budget data is never transferred — and again on the
host: code 256 KiB (`CodeTooLarge`), returned value 256 KiB (`ResultTooLarge`, with
advice to use `fields`/`limit`), logs 64 KiB and 1,000 lines with 16 bytes charged
per line (then `[logs truncated]`), SDK-call arguments 64 KiB
(`ArgumentsTooLarge`), and 16 SDK calls pending at once. The deadline defaults to
30 s (max 120 s, `timeoutMs`), longer than a parallel API would need because each
key serves one request at a time.

**Runner selection** (`pickSandbox` in `src/sandbox/index.ts`):

- single-user use (stdio, `--http --insecure`): `auto` prefers isolated-vm, then
  Deno;
- authenticated HTTP serving (OIDC providers and account mode), where many users'
  code runs on one server: **Deno only**, a separate killable process per
  execution. `--sandbox isolate` is refused at startup, and `auto` without Deno
  leaves `execute` unavailable (`SandboxUnavailable` with instructions) rather
  than falling back to in-process execution.

If no runner is available, `execute` returns `SandboxUnavailable` — the other two
tools keep working.

## Corpus

`schema/odp.json` and `schema/tsdr.json` hold the `search_api` / `describe_schema`
corpus.

- **Endpoint entries** (one per registered method, with signature, description and
  a runnable example) are hand-written. `test/sources.spec.ts` asserts they match
  the methods tables exactly; `test/corpus.spec.ts` parses every example, runs it
  through the real preflight and checks that it only calls registered methods; the
  opt-in live suite (`USPTO_LIVE=1 pnpm test:live`) runs every ODP example against
  USPTO.
- **Field entries** under `<binding>.fields.*` are generated by
  `scripts/gen-fields.mjs` from sample responses listed in
  `scripts/field-samples.json`: ODP from live captures made with
  `scripts/capture-samples.mjs`, TSDR (until a TSDR key is available) from the MIT
  sample responses in patent-dev/uspto-odp. The generator validates the whole
  manifest before writing anything, writes atomically, records a `provenance`
  block (sources and file hashes) in each schema file, describes how each API
  family is queried (ODP search body vs legacy DSAPI criteria), and never emits
  example values for personal-data or free-text fields (names, addresses, e-mail,
  OCR text, …). Curated entries such as `odp.syntax.search`, `odp.limits` and
  `odp.documentCodes` are kept.
- The method section of `docs/sdk-reference.md` is generated from the same files
  (`scripts/gen-sdk-reference.mjs`); a test fails when it is stale.

## Streamable HTTP transport

The server speaks MCP `2026-07-28`, whose protocol core is **stateless**: there
is no `initialize`/`initialized` handshake and no `Mcp-Session-Id`. Every request
is self-contained, carrying its protocol version, client info, and capabilities
in `_meta`.

`--http` enables a Node `http.Server` that handles:

- `GET /.well-known/oauth-protected-resource/mcp` — RFC 9728 metadata
  document (`resource`, `authorization_servers`, `bearer_methods_supported`,
  `scopes_supported`).
- `GET /health` — liveness probe (used by Docker `HEALTHCHECK` and Railway).
- `POST /mcp` — the MCP endpoint. Each POST is one complete JSON-RPC request.
  `MCP-Protocol-Version` and `Mcp-Method` are required, plus `Mcp-Name` for
  `tools/call`; a header that disagrees with the body is rejected with
  `-32020 HeaderMismatch`. `GET`/`DELETE` on this path return `405`.
- `server/discover` returns supported protocol versions, capabilities, and
  server identity on demand.

`tools/list` and `server/discover` results carry `ttlMs` and `cacheScope`
(`300000` / `public`): the catalog is derived from process configuration, never
from the caller. (In account mode the anonymous and signed-in endpoints have
different catalogs at different URLs.)

Pre-2026 clients are still served: requests without the `_meta` envelope are
answered by a per-request stateless `2025-11-25` fallback, so the `initialize`
handshake continues to work. No session is minted on either path.

Authentication fails closed. `USPTO_AUTH_PROVIDER`:

| Provider | Behavior |
|----------|----------|
| `none` | Only with `--insecure` (an unauthenticated local server, bound to `127.0.0.1` unless `HOST`/`--host` says otherwise). `--http` without `--insecure` and without a real provider refuses to start. |
| `generic-oidc` | Bearer JWTs verified with `jose` against `USPTO_AUTH_JWKS_URL` (https; http only on loopback). `USPTO_AUTH_ISSUER` and `USPTO_AUTH_AUDIENCE` are required; tokens must carry `exp` and a non-empty `sub`, use an asymmetric algorithm, and hold every scope listed in `USPTO_AUTH_SCOPES` (`403 insufficient_scope` otherwise). |
| `clerk`, `workos`, `auth0` | Aliases of `generic-oidc` — set the issuer, audience and JWKS URL of your tenant. |
| `accounts` | Google sign-in, personal encrypted USPTO keys, OAuth/PKCE — see [accounts.md](./accounts.md). |

Any other value stops startup.

The HTTP transport also enforces:

- **Host validation (DNS rebinding)** — every request's `Host` must be the host of
  `USPTO_PUBLIC_ORIGIN`, one of `USPTO_ALLOWED_HOSTS`, or loopback on the listening
  port (`421` otherwise). The trusted origin is never derived from the request.
  Listening on a non-loopback address without `USPTO_PUBLIC_ORIGIN` or
  `USPTO_ALLOWED_HOSTS` is a startup error; `USPTO_ALLOWED_HOSTS=*` disables the
  check (only behind a proxy that validates `Host` itself).
- **Origin validation** — browser-originated requests to `/mcp` are rejected with
  `403` unless the origin is the server's own, a loopback origin, or listed in
  `USPTO_ALLOWED_ORIGINS`. Requests without an `Origin` header pass.
- **Request limits** — bodies over 1 MiB get `413`; tool arguments with more than a
  fixed number of array elements / object members are rejected
  (`maxToolInputElements`).
- **Per-IP rate limit** — token bucket with `USPTO_IP_RPS` / `USPTO_IP_BURST`,
  keyed on the TCP peer, or on `USPTO_CLIENT_IP_HEADER` behind a proxy
  (Railway: `x-real-ip`).
- **Per-subject daily quota** — `USPTO_SUBJECT_DAILY_QUOTA` requests per
  authenticated subject per UTC day. Auth runs on every request, so this quota and
  the per-subject USPTO quotas are keyed on the subject that request's own token
  verified as.
- **Graceful shutdown on SIGTERM** — running executions are aborted, the MCP
  handler is closed, then the listener.

## Layout

```
src/
  bin.ts                   # CLI entry; the only module that reads process.env (plus the logger)
  index.ts                 # library exports
  server/                  # MCP server, transports, authz, rate limiting
  tools/                   # the three tools (execute: admission, budgets, cancellation)
  sdk/                     # odp/tsdr clients, sources registry, RPC dispatch
  sandbox/                 # isolate + deno runners, AST preflight, byte budgets
  search/                  # BM25 + corpus
  accounts/                # account mode: Better Auth, portal API, encrypted key store, key gates
  supervisor/              # builds sources, gates, buckets, quotas, limiter; picks sandbox
  util/                    # http client, upstream gate, execution context/limiter, token bucket, quotas, logger
schema/
  odp.json                 # Open Data Portal endpoint + field corpus (+ provenance)
  tsdr.json                # TSDR endpoint + field corpus (+ provenance)
scripts/
  capture-samples.mjs      # captures live ODP sample responses (needs a key)
  gen-fields.mjs           # regenerates <binding>.fields.* from sample responses
  gen-sdk-reference.mjs    # regenerates the method section of docs/sdk-reference.md
  mcpb-prepare.mjs         # stages and validates the MCPB bundle
  mcpb-smoke.mjs           # runs execute in an unpacked bundle
  release.mjs              # computes the next version and CHANGELOG section
web/                       # React account / connect / consent pages (account mode)
test/                      # vitest specs (live.spec.ts is opt-in)
examples/                  # snippets you can paste into `execute`
deploy/                    # Dockerfile, railway.toml, RAILWAY.md
docs/                      # this file, sdk-reference.md, accounts.md
```
