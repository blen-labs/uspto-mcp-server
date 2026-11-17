# Support

This is an independent open-source project. It is not affiliated with or endorsed by the
USPTO. Help is given on a best-effort basis by the maintainers.

## Before you ask

- **Documentation:** <https://uspto.mcp.blenlabs.com/docs/> has connect guides for Claude
  Desktop, Cursor and VS Code, key setup, and recipes.
- **SDK reference:** [`docs/sdk-reference.md`](./docs/sdk-reference.md) lists every
  `odp.*` and `tsdr.*` method, the search syntax, and the errors.
- **Examples:** [`examples/`](./examples/) holds programs you can paste into `execute`.
- **Existing issues:** search the
  [issue tracker](https://github.com/blen-labs/uspto-mcp-server/issues?q=is%3Aissue), open
  and closed.

## Where to go

| You have | Go to |
|---|---|
| A bug, or behaviour that differs from the docs | [Open a bug report](https://github.com/blen-labs/uspto-mcp-server/issues/new?template=bug_report.md) |
| An idea for a new SDK method, tool argument or setting | [Open a feature request](https://github.com/blen-labs/uspto-mcp-server/issues/new?template=feature_request.md) |
| A question about using or hosting the server | [Ask a question](https://github.com/blen-labs/uspto-mcp-server/issues/new?template=question.md) |
| A security vulnerability (sandbox escape, auth bypass, key leak) | A [private security advisory](https://github.com/blen-labs/uspto-mcp-server/security/advisories/new). See [`SECURITY.md`](./SECURITY.md). Never a public issue. |
| A problem with your USPTO.gov account, ID.me verification or API key | USPTO: [Register for ODP access](https://data.uspto.gov/support/universal-registration), [Manage API Key](https://data.uspto.gov/apikey) for the ODP key, and the [API Key Manager](https://account.uspto.gov/api-manager) for the TSDR key. This project cannot see or change your account. |
| A question about the BLEN-hosted service, its terms or your data | **opensource@blencorp.com**. See the [Terms of Service](./legal/terms.md) and [Privacy Policy](./legal/privacy-policy.md). |
| A Code of Conduct concern | **conduct@blenlabs.com**. See the [Code of Conduct](./CODE_OF_CONDUCT.md). |

## What to include

A report we can act on has:

- the server version (the version your MCP client shows for `uspto-mcp-server`, or your
  git SHA; `npm view` shows the newest release, not the one you run), the transport (stdio or HTTP), the sandbox runner (`isolate` or
  `deno`), your Node version and your MCP client;
- the exact code you passed to `execute`, or the `search_api` query;
- the full error envelope (`{ ok, error: { name, message, status }, logs }`);
- server log lines, if you have them (`USPTO_LOG_LEVEL=debug` gives more detail).

**Never paste an API key.** The server keeps keys out of results and logs, but a client
configuration file or a shell history does not. Remove names and addresses from captured
USPTO responses too: they are public records, but an issue is not the place for them.

## What we cannot do

- Give legal advice, or interpret a patent or trademark record for you.
- Speed up, repair or explain an outage of the USPTO APIs. When an endpoint changes
  upstream, a bug report with the request and the response status is the fastest way to
  get the SDK updated.
- Share an API key. USPTO keys are personal; every user needs their own.

## Contributing

To fix something yourself, start with [`CONTRIBUTING.md`](./CONTRIBUTING.md).
