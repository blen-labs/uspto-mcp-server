# Deploying to Railway

The included `deploy/Dockerfile` and `deploy/railway.toml` produce a single-process
HTTP MCP server on Node 26 (LTS) with Deno 2.9.8 included. Authenticated HTTP serving runs
user code only in the Deno sandbox (a separate permissionless process per
execution), so the image has everything `execute` needs.

**Authentication is required.** The image's default command is `node dist/bin.js
--http`, which refuses to start until you configure either personal accounts
(`USPTO_AUTH_PROVIDER=accounts`, the recommended way to host this — see
[account setup](../docs/accounts.md)) or an OIDC provider (section 3).

## 1. Create the service

1. Create a new Railway project pointed at this repo.
2. **If this server lives in a subdirectory** of a larger repo (e.g. `uspto-mcp-server/`),
   set **Settings → Source → Root Directory** to that subdirectory. All paths
   below are relative to that root.
3. In **Settings → Build**, set the **Dockerfile path** to `deploy/Dockerfile`.
   (Or copy `deploy/railway.toml` to the root and Railway will pick it up.)
4. Railway will inject `PORT`. Our server binds to it automatically.
5. Attach your custom domain (e.g. **`your-host.example.com`**) in **Settings →
   Networking → Custom Domains**, then add the `CNAME` Railway gives you to
   your DNS zone. Wait for the cert to provision before testing the metadata
   URL below.

## 2. Required environment variables

Set these in **Settings → Variables**:

| Variable | Required | Example | Notes |
|---|---|---|---|
| `USPTO_PUBLIC_ORIGIN` | yes | `https://your-host.example.com` | Public origin clients see. Used in OAuth resource metadata and `WWW-Authenticate` URLs, and its host is the trusted `Host` (the server binds `0.0.0.0` here, which requires it). |
| `USPTO_ALLOWED_HOSTS` | if more hostnames | `alias.example.com` | Extra accepted `Host` values (DNS-rebinding protection). |
| `USPTO_ALLOWED_ORIGINS` | if browser clients | `https://app.example.com` | Extra browser Origins allowed on `/mcp`. Own origin + loopback always pass; non-browser clients (no Origin header) are unaffected. |
| `USPTO_API_KEY` | OIDC mode only | — | Your own Open Data Portal key. USPTO keys are personal ("Do not share it with others"), so with an OIDC provider use it only for yourself. Ignored in account mode, where each user saves their own. |
| `USPTO_TSDR_API_KEY` | OIDC mode only | — | Your own TSDR key; same rules. |
| `USPTO_LOG_LEVEL` | no | `info` | `debug`/`info`/`warn`/`error`. |
| `USPTO_USER_AGENT` | recommended | `acme-uspto-mcp/1.0 (contact: ops@acme.com)` | Identify your deployment to USPTO. |
| `USPTO_SANDBOX` | no | `auto` | Leave `auto` (Deno). `isolate` is refused for authenticated HTTP serving. |
| `USPTO_CLIENT_IP_HEADER` | yes | `x-real-ip` | Without it the per-IP rate limit sees Railway's internal proxy addresses, not clients. |

## 3. Authentication

Use **personal accounts** (see the last section) unless you are hosting the server
only for yourself. With an OIDC issuer that publishes a JWKS endpoint:

| Variable | Required | Example |
|---|---|---|
| `USPTO_AUTH_PROVIDER` | yes | `generic-oidc` \| `clerk` \| `workos` \| `auth0` |
| `USPTO_AUTH_ISSUER` | yes | `https://<tenant>.clerk.accounts.dev` |
| `USPTO_AUTH_AUDIENCE` | yes | `https://your-host.example.com/mcp` |
| `USPTO_AUTH_JWKS_URL` | yes (https) | `https://<tenant>.clerk.accounts.dev/.well-known/jwks.json` |
| `USPTO_AUTH_SCOPES` | no | `mcp:read` — scopes every token must carry |

Tokens must carry the issuer and audience, `exp` and `sub`, and be signed with an
asymmetric algorithm. Missing configuration or an unknown provider stops startup.
Never deploy with `--insecure`: it disables authentication.

## 4. Tunables

| Variable | Default |
|---|---|
| `USPTO_IP_RPS` | `5` (token-bucket sustained rate per IP) |
| `USPTO_IP_BURST` | `20` (token-bucket burst per IP) |
| `USPTO_CLIENT_IP_HEADER` | unset. **Set to `x-real-ip` on Railway**: the edge overwrites it with the client address, while the app's TCP peer is an internal proxy address that changes per connection. |
| `USPTO_SUBJECT_DAILY_QUOTA` | `10000` requests per authenticated subject per day |
| `USPTO_CACHE_TTL_MS` | `600000` (10 min upstream LRU) |
| `USPTO_UPSTREAM_TIMEOUT_MS` | `30000` |
| `USPTO_UPSTREAM_RETRIES` | `2` (network errors and 5xx; a 429 pauses the key ≥ 5 s and is retried once only if the pause is ≤ 30 s) |
| `USPTO_ODP_MAX_CALLS_PER_EXECUTE` / `USPTO_TSDR_MAX_CALLS_PER_EXECUTE` | `50` / `25` |
| `USPTO_ODP_RATE_PER_HOUR` / `USPTO_TSDR_RATE_PER_HOUR` | `5000` / `3000` (per configured key; per account in account mode) |
| `USPTO_MAX_CONCURRENT_EXECUTIONS` / `USPTO_MAX_EXECUTIONS_PER_SUBJECT` | `8` / `2` |
| `USPTO_ODP_CONCURRENCY` / `USPTO_TSDR_CONCURRENCY` | `1` / `1` — USPTO blocks concurrent requests per key; keep 1 |

**Run one instance.** The per-key queues, hourly buckets (outside account mode) and quotas
are in memory, so a second replica could send concurrent requests with one key and draw `429`s
from USPTO. `deploy/railway.toml` sets `numReplicas = 1`.

**Deploys briefly overlap, and that is handled.** Railway activates the new deployment before it
sends `SIGTERM` to the old one ([deployment teardown](https://docs.railway.com/deployments/deployment-teardown));
it cannot stop the old deployment first. `railway.toml` keeps that window as short as Railway
allows (`overlapSeconds = 0`), and on `SIGTERM` the old process immediately cancels its running
executions and in-flight USPTO calls (`drainingSeconds = 15` is ample). If both processes still
send a request with the same key in that moment, USPTO answers `429`: the server then pauses that
key for at least 5 seconds (or `Retry-After`) and retries once. Usually callers see only a short
delay, but this is a residual risk, not a guarantee: a second `429` or a long `Retry-After` surfaces
as a `RateLimited` error, and executions still running on the old instance at `SIGTERM` end with
`AbortError`. If you need strict non-overlap, deploy by stopping the running deployment, confirming
it has exited, and only then starting the new one, accepting downtime. If you configure the service in the dashboard instead, keep the same
settings. See `.env.example` for the full list.

## 5. Verifying after deploy

```bash
# 1) Resource metadata (RFC 9728)
curl -s "$URL/.well-known/oauth-protected-resource/mcp" | jq

# 2) Health (in account mode it also checks the database). Expect "sandbox": "deno".
curl -s "$URL/health" | jq

# 3) List tools (unauthed gets 401 with WWW-Authenticate).
#    MCP 2026-07-28 is stateless: no handshake, no session id to carry.
curl -i -X POST "$URL/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/list' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Every request is self-contained, so this same shape works against any replica.
`Mcp-Method` (and `Mcp-Name` on `tools/call`) are required and must agree with
the body — a mismatch is rejected with `-32020`.

## 6. Pointing Claude at it

```json
{
  "mcpServers": {
    "uspto": {
      "type": "http",
      "url": "https://your-host.example.com/mcp"
    }
  }
}
```

Claude follows the OAuth Protected Resource Metadata flow automatically when it
sees a `401` with a `WWW-Authenticate` header pointing at your metadata URL.

## 7. Image notes

- Both stages use `node:26-trixie-slim` (Debian 13), pinned by digest; `isolated-vm` 7 installs its prebuilt
  binary, so there is no compiler toolchain. The Deno binary is copied from the
  `denoland/deno:bin-2.9.8` image, also pinned by digest. Dependabot proposes digest bumps.
- The image runs as a non-root user and contains `LICENSE`, `NOTICE`, and the
  generated `dist/web/THIRD_PARTY_NOTICES.txt`. `.dockerignore` keeps `.env*`,
  `.git`, local state and tests out of the build context.
- `dumb-init` is the PID 1 so signals are forwarded cleanly. On `SIGTERM`/`SIGINT`
  the server aborts running executions and their in-flight USPTO calls, closes the
  MCP handler, then the listener.

## Account authentication

For personal USPTO keys (each user's own ODP and TSDR keys), follow [account setup](../docs/accounts.md).
Provision a dedicated PostgreSQL database, configure the Google callback and the
listed secrets, and set `USPTO_AUTH_PROVIDER=accounts`. Remove `--insecure` from
any Railway start-command override. The image's default command already supports
account mode. Account mode serves two URLs: `/mcp/account` (sign in with Google;
all tools, with the user's own keys) and `/mcp` (no sign-in; documentation tools
only — `execute` needs an account). Do not set `USPTO_API_KEY` /
`USPTO_TSDR_API_KEY` here: account mode ignores them, because USPTO keys are
personal.
