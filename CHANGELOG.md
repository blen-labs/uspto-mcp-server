# Changelog

All notable changes to this project are documented here. Releases are cut automatically
from `main` (see CONTRIBUTING.md, "Releasing").

## [Unreleased]





## [0.2.1] - 2026-11-13

### Fixed
- keep runtime diagnostics from callers and survive a rejected dispatch (sandbox)
- give Deno sandbox code only the language's globals (sandbox)
- check the code as a script and as a module (sandbox)
- bound the memory of the Deno sandbox process (sandbox)

### Changed
- take the expected version from package.json (release)
## [0.2.0] - 2026-11-13

### Added
- serve the documentation site at /docs (accounts)

### Fixed
- override fflate to a patched version (site)

### Changed
- describe where the site is served (site)
- cover /docs wiring and real path traversal (accounts)
- publish at uspto.mcp.blenlabs.com/docs (site)
- audit the site's lockfile and drop the GitHub Pages workflow
- build the documentation site into the image (docker)
- point remote clients at the hosted connector (site)
- publish the documentation site to GitHub Pages (docs)
- add the documentation site (site)
- attach the Claude Desktop bundle to the GitHub Release (release)
## [0.1.2] - 2026-11-13

### Fixed
- ignore merge-message subjects that arrive as single-parent commits (release)

### Changed
- push the release commit as a GitHub App so main can require PRs (release)
## [0.1.1] - 2026-11-13

### Fixed
- derive the manifest Node range from engines and smoke it on Node 24 (mcpb)
- declare the same Node range as engines (mcpb)

### Changed
- make Node and @types/node major bumps deliberate (deps)
- package and release on Node 26 and test with Deno 2.9.8
- run Node 26 LTS on Debian 13 with Deno 2.9.8, pinned by digest (docker)
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

[Unreleased]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/blen-labs/uspto-mcp-server/releases/tag/v0.1.0
