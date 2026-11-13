# Examples

Each file here is a snippet you can paste verbatim into the `execute` tool.
They're plain JavaScript — the sandbox rejects TypeScript type annotations —
and use top-level `await` and `return`, which `execute` allows because it wraps
your code in an async function. `odp` and `tsdr` are sandbox globals, so the
files aren't runnable with plain `node`. `test/examples.spec.ts` runs each one
against a canned response to keep them pasteable.

| File | Demonstrates |
|------|--------------|
| [`patent-portfolio.js`](./patent-portfolio.js) | `odp.patents.search` with `q`, `filters`, `rangeFilters`, `sort`, `fields` and `facets`: an applicant's recent granted patents. |
| [`ptab-challenges.js`](./ptab-challenges.js) | PTAB: every trial filed against a patent (`odp.ptab.proceedings.search`), then the decisions in one trial (`odp.ptab.decisions.byTrial`). |
| [`prosecution-history.js`](./prosecution-history.js) | Patent number → application (`odp.patents.byPatentNumber`), then its office actions and rejection grounds (`odp.officeActions.search`). |
| [`trademark-status.js`](./trademark-status.js) | TSDR: status of several trademark cases in one request (`tsdr.multiStatus`). |

## Tips for sandboxed code

- USPTO serves **one request at a time per API key**, so calls queue. Prefer one
  well-filtered search over many lookups; `Promise.all` is safe but not faster.
- Always pass `fields` on searches: full patent and PTAB records are large
  (PTAB documents include OCR text). Upstream responses over 8 MiB fail with
  `ResponseTooLarge`, and a value over 256 KiB returned from `execute` fails with
  `ResultTooLarge` — return only the attributes you need.
- Start with a small `limit` (5–25) and widen once you know what you're after;
  `count` tells you the total.
- Use `facets` to get counts without paging through records.
- Each `execute()` may make at most 50 `odp` and 25 `tsdr` upstream calls.
- A search with no matches returns `{ count: 0, …Bag: [] }`, not an error.
- SDK errors (`NotFound`, `RateLimited`, `HttpError`, …) carry the HTTP `status`.
  Uncaught, they end the execution and come back in the result envelope's `error`
  field — you don't need a `try/catch` unless you want to handle them inline.
- Rejection grounds in `rejectionTypeBag` are `'101'`, `'102'`, `'103'`, `'112'`.

See [`../docs/sdk-reference.md`](../docs/sdk-reference.md) for the full method
list, or call `search_api({ query: '...' })` / `describe_schema(...)` from inside
the model.
