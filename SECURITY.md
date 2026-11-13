# Security Policy

## Reporting a vulnerability

Please **do not file public GitHub issues for security reports**. Instead,
open a private GitHub Security Advisory:

> <https://github.com/blen-labs/uspto-mcp-server/security/advisories/new>

If that's not available, contact the maintainers via the GitHub organization
page at <https://github.com/blen-labs>.

We try to respond within **3 business days**. A typical timeline for a
confirmed sandbox-escape report:

1. Initial acknowledgement and severity triage — within 3 business days.
2. Coordinated fix in a private branch — within 14 days for critical, 30 for
   high-severity issues.
3. Patched release published to npm with a credit line (unless you ask not
   to be credited).
4. Public advisory and CVE filing once users have had reasonable upgrade time.

## Scope

In scope:
- **Sandbox escapes** — any code in `execute` that gets host filesystem,
  network, environment, subprocess, native binding, or out-of-isolate
  references.
- **AST preflight bypasses** — code that passes `preflight()` in
  `src/sandbox/policy.ts` but performs disallowed operations at runtime.
- **Auth bypass** — sending requests to `/mcp` (or `/mcp/account` in account
  mode) without a valid bearer that reaches a tool handler, or reaching `execute`
  on account mode's anonymous `/mcp`.
- **Key exposure** — any way for sandboxed code, logs, results or errors to reveal
  an API key, or for one user's key to serve another user's calls.
- **Resource bounds** — an execution that outlives its deadline, leaves a process
  behind, or makes the host buffer more than the documented byte budgets.
- **DNS rebinding / SSRF** against the HTTP transport.
- **Quota / rate-limit bypass** that allows a single subject or IP to exceed
  the configured ceiling.

Out of scope (please file a normal issue instead):
- Upstream API rate limits (those are USPTO limits; see the `USPTO_ODP_*` /
  `USPTO_TSDR_*` guardrails in the README).
- Denial of service via lawful but expensive queries (we accept this risk
  on a per-tenant basis; tune `USPTO_SUBJECT_DAILY_QUOTA` and
  `USPTO_IP_RPS`).
- Issues that only occur with `--insecure` (which is documented as dev-only).

## Sandbox guarantees

The `execute` tool runs user-supplied JavaScript with layered defenses:

1. **AST preflight** (`acorn` + `acorn-walk`, see `src/sandbox/policy.ts`):
   rejects `import` / `import()` / `eval` / `new Function` and references to
   `process`, `globalThis`, `Buffer`, `Deno`, `fetch`, `Worker`, plus
   `__proto__` / `constructor` / `prototype` member access. The check rejects
   *static* uses of these names; runtime synthesis (e.g. via string
   concatenation) is the next layer's job. It reads the code both as a module
   and as a script, because the two grammars treat HTML-like comments
   differently, and it rejects code that closes the function that wraps it.
2. **Runtime isolation** — one of:
   - `isolated-vm`: a fresh V8 isolate per execution, **no host references**
     other than a Reference to the RPC dispatcher and a log sink for `console.*`;
     heap cap; a host-owned wall-clock deadline (started before setup, covering
     never-settling promises) disposes the isolate. It runs inside the server
     process, so it is used only for single-user operation (stdio, `--insecure`).
   - Deno: `deno run --no-prompt --no-config --no-lock --no-remote --no-npm` of a
     fixed supervisor script with **no `--allow-*` flags** (no net/fs/env/ffi/
     subprocess access) and a minimal environment. User code arrives by message
     (it is never written to disk) and runs in a module Worker whose `Deno`,
     `postMessage`, `fetch`, `Worker`, `WebSocket`, … globals are replaced with
     `undefined`. Frames to the host are prefixed with a random token the worker
     never sees; all other output is untrusted text. The host owns the deadline,
     kills the process group, and waits for the child to exit before releasing the
     execution. The heap flag does not count buffers, so the supervisor also ends
     the process when its resident memory has grown by more than twice `memoryMb`
     plus 96 MiB during an execution. It checks every 5 ms, so a program can pass
     that bound by what it writes in one interval.
     **Authenticated HTTP serving uses only this runner** (an
     in-process runner is refused there, with no fallback).
3. **Byte budgets**, enforced inside the sandbox before transfer and again on the
   host: code 256 KiB, result 256 KiB, logs 64 KiB / 1,000 lines, SDK-call
   arguments 64 KiB, 16 pending calls. Executions are capped per server and per
   subject, and are aborted when the client cancels or disconnects.

Both runners deny network access to user code; the only way to reach
upstream APIs is via the `odp.*` / `tsdr.*` proxies, which serialize calls
through a host-side RPC and execute them against the configured base URLs
(`USPTO_ODP_BASE_URL`, `USPTO_TSDR_BASE_URL`; account mode always uses the
official `https://api.uspto.gov` and `https://tsdrapi.uspto.gov`). Identifiers must
match strict grammars (no dot segments or separators), so sandbox input cannot
change which endpoint is called. Upstream bodies are capped at 8 MiB, including
gzip expansion.

The dispatcher resolves exact method names from each source's explicit, frozen
`methods` table. It never traverses the host client object or inherited
properties. Only the registered read methods are callable; HTTP clients,
caches, and other host internals are outside the RPC surface. New SDK methods
must be explicitly registered before sandboxed code can call them.

The USPTO API keys (`USPTO_API_KEY`, `USPTO_TSDR_API_KEY`, and in account mode
each user's saved keys) are held host-side in the `HttpClient` and are **never
exposed to sandboxed user code**: they are injected into the upstream request on
the host side of the RPC bridge, not passed into the sandbox, so user code cannot
read or exfiltrate them. If an upstream echoes a key back, it is replaced with
`[REDACTED]` in raw text, decoded JSON values and keys, and error messages, in
every mode. Account mode never uses one user's key for another user's calls, and
never uses an operator key at all (USPTO keys are personal).

We treat any of the following as a vulnerability:
- Reading the contents of any file under `/`.
- Establishing any outbound socket to a host not configured in the SDK.
- Reading process environment variables.
- Reading or modifying host globals (this includes obtaining `globalThis`,
  `Reflect`, `Function`, `eval`, or any constructor reachable from them).
- Causing the host process to crash, or an execution (or its child process) to
  outlive `timeoutMs` plus a few seconds.
- Forging the result of an execution or of an SDK call from sandboxed code in a
  way the host accepts as protocol data.

## Threat model

This server is designed to be exposed to **untrusted MCP clients** behind
authentication: personal accounts (Google sign-in + OAuth/PKCE, account mode) or
an external OIDC issuer (Clerk / WorkOS / Auth0 / generic OIDC) verified via JWKS
with required issuer, audience, expiry, subject and scopes. It fails closed: `--http`
without real authentication refuses to start, and an unknown provider stops
startup. The HTTP transport checks `Host` against configured names (DNS rebinding;
the trusted origin is never taken from the request), validates browser `Origin`s,
caps request bodies at 1 MiB, and adds per-IP token-bucket rate limiting and
per-subject daily quotas.

The only unauthenticated public surface by design is account mode's `/mcp`, which
offers documentation tools only (no code execution, no USPTO calls).
`--insecure` disables authentication for local development and binds to
`127.0.0.1` by default; operators who expose it publicly opt out of all auth-layer
protections and accept the resulting risk.

## Dependencies

We track advisories on direct runtime dependencies — `@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, `undici`, `jose`, `acorn`, `lru-cache`, `zod`,
`express`, `better-auth`, `pg`, and the optional `isolated-vm` — plus the Deno
runtime pinned in the Docker image. CI fails on any known advisory
(`pnpm audit --audit-level moderate`, dev dependencies included), and Dependabot
proposes updates weekly. For an advisory that affects this server, expect a patch
release within the timeline above.
