# USPTO MCP Server

[![CI](https://github.com/blen-labs/uspto-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/blen-labs/uspto-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@blen/uspto-mcp-server.svg)](https://www.npmjs.com/package/@blen/uspto-mcp-server)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-24%20%7C%2026-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-7c3aed.svg)](https://modelcontextprotocol.io/specification/2026-07-28)

**Ask your AI assistant real questions about U.S. patents and trademarks — and get answers grounded in the official USPTO APIs.**

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects any MCP client (Claude Desktop and others) to the U.S. Patent and Trademark Office's public APIs:

- **[USPTO Open Data Portal (ODP)](https://data.uspto.gov)** — `api.uspto.gov`: the Patent File Wrapper (bibliographic data, status, continuity, assignments, patent term adjustment, attorneys, transactions, document lists), PTAB trials, appeals and interferences, petition decisions, office actions (full text, rejections, citations), and the bulk-dataset catalog. `developer.uspto.gov` now redirects here.
- **[TSDR](https://tsdrapi.uspto.gov)** — Trademark Status & Document Retrieval: trademark case status and document lists.

Instead of bolting on dozens of rigid, narrow tools, it hands the model a small, well-documented SDK and lets it write the exact query it needs in JavaScript — then runs that code in a locked-down sandbox. This is the **code-mode** pattern, and it makes wide government APIs usable without overwhelming the model with tool definitions.

> Independent open-source project. It calls public USPTO APIs and is not affiliated with or endorsed by the USPTO or the U.S. government.

## API keys

Both sources need a free, **personal** API key. USPTO issues one key per account and says: *"Do not share it with others. It is an identifier unique to you"* ([Getting Started](https://data.uspto.gov/apis/getting-started)). The keys are held host-side and never reach the sandbox.

| Source | Key | How to get it | Env var |
|---|---|---|---|
| `odp` | ODP API key, sent as `X-API-KEY` | A USPTO.gov account with multi-factor authentication (required for all ODP use since June 18, 2026), linked once to a verified ID.me identity; then sign in at [data.uspto.gov/myodp](https://data.uspto.gov/myodp) and use **Manage API Key**. See [Register for ODP access](https://data.uspto.gov/support/universal-registration). | `USPTO_API_KEY` |
| `tsdr` | TSDR key, sent as `USPTO-API-KEY` (separate from the ODP key; the ODP key does not work on TSDR) | [USPTO API Key Manager](https://account.uspto.gov/api-manager) | `USPTO_TSDR_API_KEY` |

USPTO says a key "shouldn't expire if it is used at least one time per year". Since August 18, 2026, USPTO.gov profiles must include four additional fields; keys of accounts that had not completed them by October 8, 2026 were **deactivated** (every call returns `403`). To reactivate, complete the fields under **Open Data Portal** in your USPTO.gov account settings, then click **Activate API Key** on the ODP Manage API Key page.

Without a key, that source is **disabled**: its global still exists in the sandbox, but calls return a `SourceUnavailable` error that says how to get one, while the other source keeps working.

## Quickstart (Claude Desktop)

Add the server to your Claude Desktop config (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "uspto": {
      "command": "npx",
      "args": ["-y", "@blen/uspto-mcp-server"],
      "env": {
        "USPTO_API_KEY": "your-odp-key",
        "USPTO_TSDR_API_KEY": "your-tsdr-key"
      }
    }
  }
}
```

Restart Claude Desktop, then ask in plain language:

> *"Which IPRs have been filed against patent 10,169,987, and how did they end?"*
> *"Show the office actions and rejection grounds for application 17/248,024."*
> *"What's the status of trademark serial number 97123456?"*

Requires **Node.js 24 or 26** (LTS). `npx` downloads and runs the server on demand. If `execute` reports `SandboxUnavailable`, see [Sandbox runtimes](#sandbox-runtimes). A Claude Desktop extension bundle (`.mcpb`) that asks for the keys at install time is built from this repository (`pnpm mcpb:prepare && pnpm mcpb:pack`).

## See it in action

> *"Has anyone challenged patent 10,169,987 at the PTAB?"*

The model finds the right calls with `search_api` and runs them in the sandbox:

```js
const trials = await odp.ptab.proceedings.search({
  q: 'patentOwnerData.patentNumber:10169987',
  fields: ['trialNumber', 'trialMetaData.trialTypeCode', 'trialMetaData.trialStatusCategory',
           'regularPetitionerData.realPartyInInterestName'],
});
const first = trials.patentTrialProceedingDataBag[0].trialNumber;
const decisions = await odp.ptab.decisions.byTrial(first);
return decisions.patentTrialDocumentDataBag.map(d => ({
  date: d.decisionData?.decisionIssueDate,
  outcome: d.decisionData?.trialOutcomeCategory,
}));
```

…then answers in plain English, citing the trials and decisions it found.

## What's covered

| Need | Call |
|---|---|
| Find applications/patents by title, applicant, inventor, CPC, dates, status | `odp.patents.search` |
| Application behind a granted patent number | `odp.patents.byPatentNumber` |
| One application's metadata, continuity, assignments, PTA, attorney, transactions, documents | `odp.patents.get` / `metaData` / `continuity` / `assignment` / `adjustment` / `attorney` / `transactions` / `documents` |
| PTAB trials (IPR/PGR/CBM/DER), decisions, papers | `odp.ptab.proceedings.*`, `odp.ptab.decisions.*`, `odp.ptab.documents.*` |
| Ex parte appeals and interferences | `odp.ptab.appeals.*`, `odp.ptab.interferences.*` |
| Petition decisions (with decision documents) | `odp.petitions.*` |
| Office action full text and rejection grounds | `odp.officeActions.*` (current) and `odp.oa.*` (legacy DSAPI: text, citations, per-claim rejections, enriched citations) |
| Bulk dataset catalog and file lists | `odp.bulk.*` |
| Trademark status (1–25 cases per call), documents, last update | `tsdr.*` |

Full surface: [`docs/sdk-reference.md`](./docs/sdk-reference.md). File downloads — PDFs, bulk files, and `search/download` CSV exports — are intentionally **not** exposed; the SDK returns their URLs instead.

## How it works

Three tools, in the order the model uses them:

| Tool | What it does |
|---|---|
| `search_api(query, k?)` | BM25 over the SDK method docs and a response-field dictionary. Returns signatures and ready-to-run JavaScript. |
| `describe_schema({ path? \| prefix? })` | Looks up an exact entry (`odp.patents.search`) or lists a namespace (`odp.ptab.`). |
| `execute({ code, timeoutMs?, memoryMb? })` | Runs JavaScript (no type annotations; top-level `await`/`return` allowed) in the sandbox with `odp` and `tsdr` as globals. `timeoutMs` defaults to 30 s (max 120 s). |

All three are annotated read-only and non-destructive (`execute` is also `openWorldHint: true`) and publish an `outputSchema`. Results come back as compact JSON text plus the same object as `structuredContent`. A failed execution (thrown error, timeout, limit) is returned with `isError: true` and the full envelope — `{ ok: false, error: { name, message, status? }, logs, durationMs }` — so the model sees what went wrong. A search with no hits returns `{ count: 0, …Bag: [] }`, not an error.

```text
MCP client → execute(code) → sandbox → odp.* / tsdr.* RPC bridge → host HttpClient (key, queue, cache) → api.uspto.gov / tsdrapi.uspto.gov
```

Architecture: [`docs/architecture.md`](./docs/architecture.md) · Paste-ready examples: [`examples/`](./examples/).

### USPTO rate limits, and how the server respects them

USPTO [allows](https://data.uspto.gov/apis/api-rate-limits) **one request in flight per API key** (burst 1; concurrent calls get `429`), 4–15 requests/second, and 5 million metadata plus 1.2 million document calls per key per week (reset Sunday 00:00 UTC). It asks clients to wait at least 5 seconds after a `429`. So the server:

- queues each key's calls through a gate: one in flight, at most 4 starts/s for ODP and 1/s for TSDR (`Promise.all` in sandbox code is safe but not faster);
- on a `429`, pauses every caller of that key for at least 5 s (or the full `Retry-After`, if longer), then retries that one call once if the pause is 30 s or less; otherwise the call fails with `RateLimited`;
- caps upstream calls per `execute()` (ODP 50, TSDR 25), per hour per key (counting every real attempt, retries included), and per authenticated subject;
- caches responses, including search POSTs keyed by their body, so repeated questions don't spend quota;
- rejects upstream bodies over 8 MiB (`ResponseTooLarge`) and results over 256 KiB returned from `execute` (`ResultTooLarge`) — use `fields` and `limit` to keep records small.

## Personal accounts (hosted mode)

`USPTO_AUTH_PROVIDER=accounts` adds Google sign-in, an `/account` page where each user saves their own ODP and TSDR keys (checked against USPTO, encrypted in PostgreSQL, never shown again), and OAuth/PKCE connections at `/mcp/account`. Each signed-in user's queries use only that user's own keys. Because USPTO keys are personal, account mode **never** uses an operator key (`USPTO_API_KEY`, `USPTO_TSDR_API_KEY` are ignored there): the anonymous `/mcp` endpoint offers only the documentation tools (`search_api`, `describe_schema`), and `execute` requires signing in. See [docs/accounts.md](docs/accounts.md).

## Sandbox runtimes

`execute` needs a sandbox runner:

1. **`isolated-vm`** — a fresh V8 isolate per execution, with a heap cap and a host-enforced deadline. `isolated-vm` 7 ships prebuilt binaries for Node 24 and 26 on macOS arm64, Linux x64/arm64 (glibc and musl) and Windows x64, so no compiler is needed. Preferred for single-user use (stdio, `--insecure` local HTTP).
2. **Deno** — user code runs in a separate `deno` process with no permissions (no network, files, env or subprocesses), inside a Worker stripped of `Deno`, `fetch` and messaging globals; the server owns the deadline and kills the process group. Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) and it is used when `isolated-vm` is unavailable, or always with `--sandbox deno` (`USPTO_SANDBOX=deno`).
3. **Authenticated HTTP serving** (OIDC or accounts) runs user code **only** in the Deno runner — a separate, killable process per execution. `--sandbox isolate` is refused there, and without Deno, `execute` reports `SandboxUnavailable` instead of falling back to in-process execution.
4. If no runner is available, `search_api` and `describe_schema` still work; `execute` returns `SandboxUnavailable` with instructions.

Every execution is bounded: code 256 KiB, returned value 256 KiB (`ResultTooLarge`), logs 64 KiB / 1,000 lines, SDK-call arguments 64 KiB, 16 calls pending at once. At most 8 executions run at once per server and 2 per authenticated subject (`USPTO_MAX_CONCURRENT_EXECUTIONS`, `USPTO_MAX_EXECUTIONS_PER_SUBJECT`); a client that cancels or disconnects stops its execution and any upstream calls in flight.

## Self-hosting (remote HTTP)

```bash
# Local, single user, no auth (binds 127.0.0.1 unless HOST/--host says otherwise):
USPTO_API_KEY=... npx @blen/uspto-mcp-server --http --insecure --port 8080

# Your own server, authenticated via an OIDC issuer (your key serves only you: see API keys).
# Issuer, audience and an https JWKS URL are all required; Deno must be installed.
USPTO_API_KEY=... \
USPTO_AUTH_PROVIDER=clerk \
USPTO_AUTH_ISSUER=https://<tenant>.clerk.accounts.dev \
USPTO_AUTH_AUDIENCE=https://your-host.example.com/mcp \
USPTO_AUTH_JWKS_URL=https://<tenant>.clerk.accounts.dev/.well-known/jwks.json \
USPTO_PUBLIC_ORIGIN=https://your-host.example.com \
  npx @blen/uspto-mcp-server --http
```

Then point any MCP client at it:

```json
{ "mcpServers": { "uspto": { "type": "http", "url": "https://your-host.example.com/mcp" } } }
```

The HTTP transport implements the stateless MCP `2026-07-28` Streamable HTTP profile — no `initialize` handshake and no `Mcp-Session-Id` — with a stateless legacy fallback for pre-2026 clients. It fails closed:

- `--http` without `--insecure` refuses to start unless real authentication is configured (an OIDC provider, or `accounts`). OIDC tokens must carry the configured issuer and audience, an expiry and a subject, use an asymmetric algorithm, and hold every scope in `USPTO_AUTH_SCOPES` (otherwise `403 insufficient_scope`).
- Listening on anything but loopback requires `USPTO_PUBLIC_ORIGIN` or `USPTO_ALLOWED_HOSTS`: every request's `Host` must match the configured names (DNS-rebinding protection); the trusted origin is never taken from the request. Browser `Origin`s other than the server's own, loopback, or `USPTO_ALLOWED_ORIGINS` get `403`.
- Request bodies are capped at 1 MiB, and tool arguments at a fixed number of elements.

It also serves OAuth 2.0 Protected Resource Metadata (RFC 9728), per-IP rate limiting and per-subject daily quotas. A Railway walkthrough is in [`deploy/RAILWAY.md`](./deploy/RAILWAY.md); the [`Dockerfile`](./deploy/Dockerfile) runs on Node 24 with Deno included.

The per-key gates, hourly buckets and quotas are in memory, so run **one replica** — and avoid deploys where an old and a new instance serve at the same time — or USPTO sees concurrent requests with one key.

### Configuration

The most common knobs (full list and defaults in [`.env.example`](./.env.example)):

| Variable | Default | Notes |
|---|---|---|
| `USPTO_API_KEY` | — | ODP key. Unset ⇒ `odp` disabled. |
| `USPTO_TSDR_API_KEY` | — | TSDR key. Unset ⇒ `tsdr` disabled. |
| `USPTO_SANDBOX` | `auto` | `auto` / `isolate` / `deno` |
| `USPTO_USER_AGENT` | `uspto-mcp-server/0.1 …` | Identify your deployment. |
| `USPTO_ODP_MAX_CALLS_PER_EXECUTE` / `USPTO_TSDR_MAX_CALLS_PER_EXECUTE` | `50` / `25` | Upstream calls per `execute()` (`CallBudgetExceeded`). |
| `USPTO_ODP_RATE_PER_HOUR` / `USPTO_TSDR_RATE_PER_HOUR` | `5000` / `3000` | Hourly attempts per configured key (per account in account mode). Must be ≥ 1. |
| `USPTO_ODP_SUBJECT_RATE_PER_HOUR` / `USPTO_TSDR_SUBJECT_RATE_PER_HOUR` | `1000` / `600` | Per authenticated subject per hour (HTTP only). |
| `USPTO_ODP_CONCURRENCY` / `USPTO_TSDR_CONCURRENCY` | `1` / `1` | Requests in flight per key. Keep 1. |
| `USPTO_ODP_RATE_PER_SEC` / `USPTO_TSDR_RATE_PER_SEC` | `4` / `1` | Requests started per second per key. |
| `USPTO_MAX_RESPONSE_BYTES` | `8388608` | Largest upstream body accepted. |
| `USPTO_MAX_CONCURRENT_EXECUTIONS` / `USPTO_MAX_EXECUTIONS_PER_SUBJECT` | `8` / `2` | Simultaneous executions per server / per authenticated subject (`Busy` beyond). |
| `USPTO_CACHE_TTL_MS` / `USPTO_CACHE_MAX_ITEMS` | `600000` / `1000` | Response cache. |
| `USPTO_AUTH_PROVIDER` | `none` | `none` (only with `--insecure`) / `generic-oidc` / `clerk` / `workos` / `auth0` / `accounts`. Unknown values stop startup. The OIDC providers serve every token holder with this server's own USPTO keys, so use them only for yourself; to host for other people use `accounts`, where each user brings their own key (USPTO keys are personal). |
| `USPTO_AUTH_ISSUER` / `USPTO_AUTH_AUDIENCE` / `USPTO_AUTH_JWKS_URL` | — | Required for OIDC providers (JWKS over https; http only on loopback). |
| `USPTO_AUTH_SCOPES` | — | Comma-separated scopes every token must carry; advertised in resource metadata. |
| `USPTO_PUBLIC_ORIGIN` | — | Public origin clients reach (OAuth metadata, trusted Host). Required for non-loopback HTTP unless `USPTO_ALLOWED_HOSTS` is set. |
| `USPTO_ALLOWED_HOSTS` | — | Extra accepted `Host` values (comma-separated); `*` disables the check (unsafe). |
| `USPTO_IP_RPS` / `USPTO_IP_BURST` | `5` / `20` | Per-IP token bucket on the HTTP transport. |
| `USPTO_CLIENT_IP_HEADER` | unset | Header your proxy overwrites with the client address (Railway: `x-real-ip`). |
| `USPTO_SUBJECT_DAILY_QUOTA` | `10000` | Requests per authenticated subject per UTC day. |

CLI options: `--http`, `--port`, `--host`, `--sandbox auto|isolate|deno`, `--insecure`, `--help`.

## Security

User code is sandboxed by design — no network, filesystem, env, or subprocess access, an `acorn` AST preflight, a host-enforced wall-clock deadline, byte budgets, and a V8 heap cap. API keys stay in the host process; any key an upstream echoes back is redacted from results and errors in every mode. The threat model is in [`SECURITY.md`](./SECURITY.md). Found a sandbox escape or auth bypass? Please open a [private Security Advisory](https://github.com/blen-labs/uspto-mcp-server/security/advisories/new) rather than a public issue.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev setup and ground rules, and please open an issue before anything non-trivial. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[Apache-2.0](./LICENSE) © 2026 BLEN, Inc. See also [`NOTICE`](./NOTICE).

## Hosted service policies

The BLEN-hosted connector's [Privacy Policy](./legal/privacy-policy.md) and
[Terms of Service](./legal/terms.md) describe data handling and conditions of
use. The software remains licensed under Apache-2.0; self-hosted operators
are responsible for their own policies.

## Acknowledgements

- The USPTO for publishing the Open Data Portal and TSDR APIs.
- [patent-dev/uspto-odp](https://github.com/patent-dev/uspto-odp) (MIT) for published sample responses, used for the TSDR part of the field dictionary until it can be captured live (the ODP part is generated from live captures).
- The [Model Context Protocol](https://modelcontextprotocol.io) team for the spec and TypeScript SDK.

---

Built by [BLEN, Inc](https://www.blencorp.com).
