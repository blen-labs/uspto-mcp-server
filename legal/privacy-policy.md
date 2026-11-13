# Privacy Policy — Patents & Trademarks MCP (by BLEN)

_Last updated: 2026-11-12_

This policy describes how **Patents & Trademarks MCP**, powered by
`@blen/uspto-mcp-server` (the "Service", operated by BLEN, Inc.), handles data
when accessed from an MCP client such as Claude, ChatGPT, or Gemini Enterprise.

The Service provides read-only access to public data from the U.S. Patent and
Trademark Office: the USPTO Open Data Portal API (`api.uspto.gov`: patent
applications, PTAB, petitions, office actions, bulk-dataset catalog) and the
Trademark Status & Document Retrieval API (`tsdrapi.uspto.gov`). Both USPTO APIs
require API keys, which USPTO issues to individuals and which must not be shared.
On the BLEN-hosted endpoint, users connect at
`https://uspto.mcp.blenlabs.com/mcp/account` with their own keys (see "Optional
personal account mode" below). The unauthenticated endpoint at
`https://uspto.mcp.blenlabs.com/mcp` offers only the documentation tools
(`search_api`, `describe_schema`); it does not run code or call USPTO, and no
operator key is used for anyone.

## What the public Service receives

- **Tool arguments and results:** search terms, schema lookup paths, and plain
  JavaScript submitted to `execute`, along with data retrieved or computed to
  answer those calls. The connector receives tool requests, not an automatic
  copy of your entire conversation. Your MCP client determines what it sends.
- **Network metadata:** our hosting provider, Railway, handles connection
  metadata and request headers. The application uses the client IP address
  visible to it (or the address in a configured proxy header) for rate limiting.
- **Support communications:** information you voluntarily provide when
  contacting BLEN for assistance.

No account is required for the unauthenticated, documentation-only endpoint. However, tool
arguments, submitted code, headers, or support messages can contain personal
information if you or your client include it. Do not submit passwords,
confidential records, or sensitive personal information in tool arguments, and
never paste API keys into a conversation — save them on the account page.

## What is sent to other services

`search_api` and `describe_schema` search bundled documentation locally.
`execute` can call the USPTO Open Data Portal and TSDR APIs. Those API requests
include the query terms, identifiers, and filters needed for your request, and your
own API key. On the hosted Service, `execute` is available only to signed-in users
and uses only that user's saved keys. The complete JavaScript body is executed on
our server, not sent to USPTO.

The application does not intentionally forward your inbound IP address,
authorization header, or MCP-client identity to USPTO. Outbound connections use
the hosting provider's network address and the server's configured User-Agent.
USPTO associates API activity with the key's holder under its own terms; when you
use your own key, USPTO can attribute those requests to your USPTO.gov account.

Results return to your MCP client. That client's storage, AI processing, and
privacy practices are governed by its own policies. Hosting and USPTO also process
requests under their applicable policies. We may disclose information where
required by law or necessary to address abuse or protect the Service.

## Storage and retention

- **Execution:** the application has no feature for saving submitted code,
  conversation histories, or tool results. Code runs in a sandbox: on the hosted
  Service, a separate short-lived process per execution that receives the code in
  memory and is terminated when the execution ends. Submitted code is not written
  to disk; the sandbox's fixed launcher script, which contains no user data, is
  stored in a private temporary directory and removed when the server process
  exits. This does not mean that every request fragment is excluded from
  operational logs.
- **Response cache:** upstream responses, with their request URLs and (for
  searches) request bodies, are cached in process memory. The default cache has a
  ten-minute freshness period and a maximum of 1,000 entries per source client;
  operators can configure these values or disable caching. Caches are separated by
  API key, are not tied to a user session, and are not persisted to disk. Stale
  entries may remain in memory until purged, evicted, or the process exits.
- **Rate-limit state:** IP buckets, per-key queues, and quota counters are stored
  in process memory (and, in account mode, in PostgreSQL).
- **Operational logs:** the application emits startup, warning, and error
  records to stderr. Debug logging can include upstream URLs, including query
  parameters. Error messages can include request fragments or URLs, never API
  keys. Hosting infrastructure may collect additional network and service logs.
  Log retention depends on the deployment's provider and configured retention
  settings; this policy does not promise a fixed deletion period.
- **Support records:** information provided to support is handled to respond
  to the request and address related operational or legal needs. Contact us
  about retention or deletion of a particular support record.

## Uses and limits

We use information to operate the Service, return requested data, limit abuse,
diagnose failures, and respond to support requests. We do not sell personal
information, build advertising profiles from connector usage, or train AI
models on submitted code, queries, or results. The MCP endpoints do not set
advertising cookies or embed browser analytics beacons. These statements do
not govern the separate MCP client or websites you choose to use.

## Self-hosted and authenticated deployments

Operators who self-host this software control their deployment, API keys,
authentication, logging, and retention. Their privacy policies apply to their
services.

When configured with an OIDC provider such as Clerk, WorkOS, Auth0, or a
generic OIDC issuer, the server validates bearer tokens and processes token
claims, including the subject and granted scopes, for authorization and quota
accounting. The separate `accounts` mode provides an authorization server and
dynamic client registration, as described below.

## Your controls

Disconnect the connector in your MCP client to stop future calls. Remove your
saved keys on the account page at any time, and revoke or rotate them with USPTO.
Consult your client's controls for conversation history and client-side
retention. For questions, access requests, or deletion requests concerning
information held by BLEN, contact **opensource@blencorp.com**. Provide enough
context to locate the relevant interaction, but do not send credentials.
Self-hosted users should contact their deployment operator.

## Security

The hosted endpoint uses HTTPS. Application safeguards include rate limits,
Host and Origin validation, JavaScript AST preflight, and sandbox isolation.
Sandbox SDK calls are restricted to explicitly registered read methods; direct
network, filesystem, environment, and subprocess access are not exposed, and API
keys never enter the sandbox. Execution defaults to a 30-second timeout and a
64 MB heap limit, with fixed limits on the size of code, results and logs; on the
hosted Service each execution runs in a separate process with no operating-system
permissions. Callers can request values within configured tool bounds. No
safeguard is a guarantee against every security incident.

## Changes and contact

Updates will be published here with a revised date. Privacy questions and
requests: **opensource@blencorp.com**. Report vulnerabilities privately using
the process in [SECURITY.md](../SECURITY.md).

## Optional personal account mode

Deployments configured with `USPTO_AUTH_PROVIDER=accounts` require Google sign-in
and OAuth authorization for access at `/mcp/account`. They store account identity
(including email address and verification status), browser sessions, OAuth client
and consent records, and encrypted provider tokens in PostgreSQL. This mode uses
essential session cookies; it does not add advertising cookies or analytics.

Users may save a personal USPTO Open Data Portal API key and, separately, a TSDR
API key on the account page. The server checks each key with its USPTO API, then
stores it encrypted with AES-256-GCM and authenticated data bound to the account
and key type. Encryption secrets are configured separately from the database. The
server sends each saved key only to its own USPTO API (`api.uspto.gov` or
`tsdrapi.uspto.gov`), in an API request header, and only for calls made through
your signed-in connection. It does not return saved keys to the browser or MCP
client, and it does not use your keys for other users. Removing or replacing a
key applies to subsequent executions; an execution already in progress may finish
using the earlier key.

Account mode stores hashed OAuth tokens and checks authorization on each request.
Response caches for your keys are kept per account and key, in process memory.
Rate-limit counters are stored in PostgreSQL, with expired counters periodically
removed. Key-change audit events contain account identifiers, action, and time,
without API-key material. Account, audit, OAuth, and backup retention is
controlled by the operator. Key removal from the live database does not delete
historical backups. Contact the operator for account deletion and retention
requests.

These details apply only where account mode has been enabled. See the deployment's
sign-in page and operator notices for the authentication mode actually in use.
