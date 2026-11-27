# Changelog

All notable changes to this project are documented here. Releases are cut automatically
from `main` (see CONTRIBUTING.md, "Releasing").

## [Unreleased]

## [0.5.3] - 2026-11-27

### Fixed
- bump undici from 8.13.0 to 8.13.1 (#46) (deps)

### Changed
- bump actions/create-github-app-token from 3.3.0 to 3.4.0 in the actions group (#43) (deps)
- correct the invariants Codex found overstated or mis-cited (claude)
- state the invariants exactly as the code enforces them (claude)
- add the security invariants checklist (claude)

## [0.5.2] - 2026-11-27

### Fixed
- refuse a zone id in the trusted client-address header (security)
- key the rate limiter only on a literal client address from the trusted header (security)

## [0.5.1] - 2026-11-27

### Changed
- fail the smoke checks on a wrong value, an error-marked result or a JSON-RPC error
- declare headCommit in the portal kit types
- require a successful legacy initialize in the smoke check; read the kit commit from the manifest root
- record the uspto-mcp-server commit in the portal kit manifest
- list test:web, kit:check and kit:update as dev-only scripts
- smoke-test the 2026-07-28 request shape in the Docker and MCPB checks

## [0.5.0] - 2026-11-27

### Added
- report the running version and commit (health)

### Changed
- list RAILWAY_GIT_COMMIT_SHA and use a version placeholder (health)
- read the platform commit in bin.ts and pass it in (health)
- inject the build info instead of stubbing the environment (health)

## [0.4.5] - 2026-11-26

### Fixed
- reject bearer tokens that are not in the authenticated format (security)

### Changed
- describe the at1-only admission order; settle the flood before assertions (accounts)

## [0.4.4] - 2026-11-26

### Fixed
- admit bearer tokens by authenticated format before the failure budget (security)

### Changed
- drive the legacy budget with the replica clock instead of fake timers (accounts)

## [0.4.3] - 2026-11-26

### Fixed
- keep example outputs in examples/outputs and the install command in a dependency-free module (docs)

### Changed
- name examples/outputs in the Dockerfile docs-stage comment
- count example statuses from returned records instead of an unverified facets shape
- fix key-storage wording, runnable shell templates, fence labels and recipe outputs
- describe what CODEOWNERS does
- add CODEOWNERS for @blen-labs/maintainers

## [0.4.2] - 2026-11-26

### Fixed
- announce the footer heart once (a11y)

### Changed
- sign "Built with ❤️ by BLEN" and add a teams call to action

## [0.4.1] - 2026-11-26

### Fixed
- canonicalize IPv6 addresses in linear time (security)
- pass the lock body to Request as a Uint8Array (types)
- choose token locks with the runtime form parser Better Auth uses (security)
- unmap every IPv4-mapped spelling, keep a leading ? in lock parsing, trim repeated grant_type (security)
- derive OAuth token locks from the executed operation and harden limiters (security)

### Changed
- make .railway/railway.ts the only Railway config (deploy)

## [0.4.0] - 2026-11-21

### Added
- let a server without accounts hide sign-in (kit)
- let product.mjs override page labels (site)
- a landing page, a shared portal kit, and WCAG 2.2 AA fixes (web)

### Fixed
- name the code blocks Expressive Code makes scrollable (site)
- on a read error drop only the file's headers (docs)
- send a docs read error without the file's headers (docs)
- report docs-site read errors instead of a 404 page (docs)
- keep queueMicrotask in the Deno worker (sandbox)
- cap the request body in the Node adapter too (http)
- prerender the policy pages so they read without JavaScript (web)
- tie only key problems to their key field (portal)
- accept hosted connectors' Origin on the signed-in MCP endpoint (accounts)
- list the portal's CSS packages in the third-party notices; make source links optional (web)
- keep platform health checks working, and require the public origin with auth (http)
- never read an inherited property for an error code; drop the npm link when not published
- show why a Google sign-in failed, and let hosted-only servers use the docs site (web)
- close review findings on the release script, MCP Origin and the portal
- end the Deno supervisor when the host goes away (sandbox)
- update better-auth, jose, undici and the portal and site tooling (deps)

### Changed
- declare the service settings in .railway/railway.ts (railway)
- restore the repository formatting of the kit files (kit)
- expect no-store on a docs read error (docs)
- declare the page-label overrides (none) in product.mjs (site)
- tolerate EPIPE as well as ECONNRESET after an early 413 (http)
- strip tags until none are left when reading policy text
- fail the browser journey in CI instead of skipping it (web)
- keep six core rules from the Biome setup (lint)
- serve the docs site through the real /docs handler in browser tests (web)
- always start the preview servers fresh (web)
- note why the signed-in MCP endpoint accepts any Origin
- release when the portal's bundled dependencies change (release)
- keep the journey's session cookies in a private temporary directory (web)
- accessibility conformance, the portal kit, and pnpm 12 notes
- run the browser accessibility suite on every pull request
- one product config, and accessibility fixes found by axe (site)
- lint for correctness and security, not just unused variables (lint)
- move to pnpm 12.21.0
- keep one blank line around each CHANGELOG section (release)

## [0.3.2] - 2026-11-20

### Fixed
- bump @better-auth/oauth-provider from 1.7.22 to 1.7.25 (#33) (deps)

## [0.3.1] - 2026-11-19

### Fixed
- bump better-auth from 1.7.22 to 1.7.25 (#30) (deps)

### Changed
- push the release commit and tag atomically (#31) (release)
- bump the dev-tooling group with 7 updates (#29) (deps-dev)
- bump the site group in /site with 3 updates (#28) (deps)
- daily dependency audit, Dependabot for site/, release only when users get a change (security)

## [0.3.0] - 2026-11-17

### Added
- link a user's own Claude organization for billing (accounts)

### Fixed
- exchange the callback code without branching on Claude's error first (accounts)
- never lose a replaced Claude connection (accounts)
- review fixes for linked Claude billing (accounts)

## [0.2.10] - 2026-11-17

### Fixed
- exempt only statute-shaped lists, and accept series 96 (search)
- keep statute lists that look like patent numbers (search)

## [0.2.9] - 2026-11-17

### Changed
- link SECURITY.md absolutely (templates)
- add a question template and send key problems to the keys page

## [0.2.8] - 2026-11-17

### Fixed
- drop design, reissue and kind-code patent numbers from queries (search)
- treat design and US-prefixed patent numbers as identifiers (search)

## [0.2.7] - 2026-11-17

### Changed
- ask for the running version, not the newest release (support)
- add an issue chooser and a support guide

## [0.2.6] - 2026-11-17

### Fixed
- decide memory and time limits by state in the isolated-vm runner (sandbox)
- keep statute lists and put patents.search first for inventor queries (search)
- accept the -- separator (cli)
- keep TimeoutError on a busy host and name refused buffers (sandbox)
- cover more question forms and list every rejection ground (search)

### Changed
- fail when an excepted advisory's package reaches the production tree
- show a real rejection in the office-action example

## [0.2.5] - 2026-11-17

### Fixed
- fail when the sources carry no version marker at all (release)
- find every stamped line in the build and match the source count (release)
- verify every stamped version line, as a fixed string (release)
- check the stamped version where #17 moved it (release)
- report MemoryLimitExceeded for a full heap in both runners (sandbox)
- refuse unknown options and send the real release in the User-Agent (cli)
- answer whole user questions and correct the tsdr.documentInfo example (search)
- point the ODP key link to data.uspto.gov/apikey (docs)

### Changed
- count only this worker's Deno children in the lifecycle test (sandbox)
- ignore the dev-only picomatch advisory until a fix ships (deps)

## [0.2.4] - 2026-11-16

### Fixed
- limit failed token checks per IP before the database (accounts)

## [0.2.3] - 2026-11-13

### Fixed
- answer 400, not 500, for a connection request without redirect_uri (accounts)
- keep rotating keys past a credential that cannot be opened (accounts)
- write the Deno supervisor again when it was deleted (sandbox)

### Changed
- the anonymous endpoint has the documentation tools only (accounts)

## [0.2.2] - 2026-11-13

### Changed
- publish to npm directly from CI (release)

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

[Unreleased]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.4.5...v0.5.0
[0.4.5]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.10...v0.3.0
[0.2.10]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/blen-labs/uspto-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/blen-labs/uspto-mcp-server/releases/tag/v0.1.0
