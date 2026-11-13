# Terms of Service — Patents & Trademarks MCP (by BLEN)

_Last updated: 2026-11-12_

## 1. Acceptance and scope

By accessing or using the BLEN-hosted **Patents & Trademarks MCP**
at `https://uspto.mcp.blenlabs.com` (the "Service", operated by BLEN,
Inc.), you agree to these terms. If you do not agree, do not use the Service.
If you use it on behalf of an organization, you represent that you are
authorized to accept these terms for that organization.

The underlying `@blen/uspto-mcp-server` software is separately licensed
under [Apache-2.0](../LICENSE). These hosted-service terms do not replace
that license or restrict rights it grants. A self-hosted deployment is
operated under its operator's terms and policies.

## 2. Independent service and data sources

The Service is an independent, read-only client for the public USPTO Open Data
Portal API (`api.uspto.gov`) and Trademark Status & Document Retrieval (TSDR) API
(`tsdrapi.uspto.gov`). Both require API keys. On the hosted Service you connect
with your own keys through a signed-in account, and `execute` runs only for
signed-in users with their own keys; the unauthenticated endpoint offers the
documentation tools only and never uses anyone's key. Availability of a source in
bundled documentation does not guarantee it is enabled.

**USPTO's API terms apply to your use.** USPTO issues API keys to individuals
(the Open Data Portal key is tied to an identity-verified USPTO.gov account) and
asks that they not be shared; you are responsible for the keys you save and for
complying with USPTO's terms, rate limits, and quotas for them. Save only your own
key. Do not save a key you are not authorized to use.

BLEN is not affiliated with, sponsored by, or endorsed by the U.S. Patent and
Trademark Office or the U.S. government. Third-party content remains subject to
any applicable rights and source notices. These terms grant no rights to
government seals, trademarks, or third-party material beyond those otherwise
available to you.

## 3. Informational use and accuracy

The Service is for informational and research purposes. It does not provide
legal advice, give patentability, freedom-to-operate, validity, or infringement
opinions, determine trademark availability, or replace official USPTO records or
the judgment of a registered patent practitioner or attorney.

Upstream data can contain errors, omissions, or delays. Responses can be
cached, and code or an AI client may filter, calculate, or summarize results
incorrectly. A status, deadline, or decision shown by the Service may since have
changed. Verify application status, dates, and documents against USPTO's official
systems (such as Patent Center, the Open Data Portal, and TSDR) before relying on
an answer or taking action.

## 4. Acceptable use

You agree not to:

- Bypass or attempt to bypass sandbox isolation, rate limits, authentication,
  or other access controls.
- Submit code or queries intended to extract secrets, access host internals,
  target unsupported systems, modify upstream records, or cause excessive load.
- Send passwords, confidential records, or sensitive personal information
  through the connector, or paste API keys into tool arguments (save keys on
  the account page instead).
- Use the Service unlawfully, infringe others' rights, or harass or target
  individuals using public records.
- Misrepresent Service outputs as USPTO action, government approval, or an
  official legal determination.

We may limit, suspend, or block access to address violations, abuse, security
incidents, or threats to service availability.

## 5. Limits and source availability

The Service applies request-rate, execution, memory, and upstream limits.
Limits depend on the deployment configuration and may change. The default
execution timeout is 30 seconds with a 64 MB heap limit, and code, results and
logs have fixed size limits; callers may request values within the tool's allowed
bounds. The number of simultaneous executions per user and per server is
limited. USPTO allows one request at a time per API key and weekly quotas per
key, so the Service queues calls and caps calls per execution; calls made with
your key count against your USPTO quota. Shared infrastructure and quotas can
affect multiple users. USPTO may impose additional limits or become unavailable.

The three tools are `search_api`, `describe_schema`, and `execute`.
`execute` accepts plain JavaScript, not TypeScript type annotations, and is
limited to the registered read-only SDK surface. The Service does not download
document or bulk files, make filings, pay fees, or perform other mutative actions
at USPTO.

## 6. Privacy

The [Privacy Policy](./privacy-policy.md) describes tool arguments, network
metadata, saved API keys, upstream disclosures, caching, and operational logging. Your MCP
client and any self-hosted operator have separate practices and terms.

## 7. Availability and warranty

The Service is provided **"as is"** and **"as available"**. To the maximum
extent permitted by law, BLEN disclaims warranties, including merchantability,
fitness for a particular purpose, and non-infringement. We do not guarantee
accuracy, uninterrupted availability, compatibility with every MCP client,
or continued free access. We may change or discontinue the hosted Service.

## 8. Liability

To the maximum extent permitted by law, BLEN, Inc. disclaims liability for
direct, indirect, incidental, special, or consequential damages arising
from use of or inability to use the Service. Nothing in these terms excludes
liability that cannot lawfully be excluded.

## 9. Changes

We may update these terms. Material changes will be noted in the repository
changelog at least 14 days before taking effect for the hosted Service.
If you do not agree to revised terms, stop using the Service.

## 10. Governing law

These terms are governed by the laws of Delaware, USA, subject to applicable
mandatory law.

## 11. Contact

Questions about these terms: **opensource@blencorp.com**. General support is
also available through [BLEN's contact page](https://www.blencorp.com/connect).
Report security vulnerabilities privately as described in
[SECURITY.md](../SECURITY.md).
