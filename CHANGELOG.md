# Changelog

All notable changes to this project are documented here. Releases are cut automatically
from `main` (see CONTRIBUTING.md, "Releasing").

## [Unreleased]

## [0.1.0] - 2026-11-12

### Added

- Code-mode MCP server for the USPTO Open Data Portal (`odp.*`: patent file wrapper,
  PTAB trials/appeals/interferences, petition decisions, office actions, legacy office-action
  datasets, bulk-dataset catalog) and TSDR trademark status (`tsdr.*`), with three tools
  (`search_api`, `describe_schema`, `execute`), stdio and stateless Streamable HTTP
  (MCP `2026-07-28`, with a legacy fallback) transports.
- Sandboxed execution: isolated-vm 7 (prebuilt for Node 24/26) for single-user use, and a
  Deno runner — a permissionless supervisor process running user code in a stripped
  Worker, with token-authenticated frames — which is the only runner for authenticated
  HTTP serving. Host-owned deadlines, process-group cleanup, byte budgets enforced inside
  and outside the sandbox, execution caps, and cancellation on client disconnect.
- Tool results as compact JSON plus `structuredContent` and `outputSchema`; failed
  executions return `isError` with the full envelope; SDK errors keep their HTTP status.
- USPTO-aware HTTP client: one request in flight per key, a shared ≥ 5 s pause (or the full
  `Retry-After`) on every `429`, per-attempt hourly budgets, response caching including
  search POSTs, bounded gzip, 8 MiB response cap, and credential redaction in every mode.
  Empty ODP searches return `count: 0` instead of a 404 error.
- Optional personal accounts (Google sign-in, OAuth/PKCE): each user's own ODP and TSDR keys,
  encrypted at rest, admitted one request at a time per key. Keys are never shared: the
  anonymous endpoint offers documentation tools only.
- Fail-closed HTTP security: authentication required unless `--insecure` (which binds to
  loopback), OIDC issuer/audience/expiry/subject/scope checks, configured-Host validation,
  Origin checks, and a 1 MiB request cap.
- Corpus with runnable examples verified against the live API, a field dictionary generated
  from live captures (no personal data), and a generated SDK reference.
- Docker image (Node 24 + Deno), an MCPB bundle (manifest v0.4) that prompts for keys, and
  third-party license notices in every artifact.

[Unreleased]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/blen-labs/uspto-mcp-server/releases/tag/v0.1.0
