# SDK reference

Two globals are available inside `execute`: `odp` (USPTO Open Data Portal,
`api.uspto.gov`) and `tsdr` (Trademark Status & Document Retrieval,
`tsdrapi.uspto.gov`). Every method is async and returns the upstream JSON (or text,
where noted) unchanged, except that an ODP search or list with no matches returns
`{ count: 0, <bag>: [] }` (USPTO itself answers those with HTTP 404). The method
reference at the end of this page is generated from the endpoint entries in
`schema/odp.json` and `schema/tsdr.json`; `search_api` and `describe_schema` serve
the same text plus a response-field dictionary (`odp.fields.*`, `tsdr.fields.*`).

Each source needs its own key (`USPTO_API_KEY`, `USPTO_TSDR_API_KEY`). Without one,
its calls throw `SourceUnavailable`.

## ODP search parameters

Every `*.search` method in `odp.patents`, `odp.ptab`, `odp.petitions`,
`odp.officeActions` and `odp.bulk` takes the same params object (or a bare query
string, treated as `q`):

| Param | Form | Sent as |
|---|---|---|
| `q` | Lucene-style query over dotted field paths: `term`, `field:value`, `"exact phrase"`, `AND`/`OR`/`NOT`, wildcard `*`, range `[A TO B]` | `q` |
| `filters` | `{ field: value \| [values] }` or `[{ name, value }]` — exact match | `filters: [{ name, value: [...] }]` |
| `rangeFilters` | `{ field: [from, to] }` or `[{ field, valueFrom, valueTo }]` | `rangeFilters` |
| `sort` | `'field desc'`, `['field asc', ...]`, or `[{ field, order }]` | `sort: [{ field, order }]` |
| `fields` | `[paths]` — return only these (records are large; use it) | `fields` |
| `facets` | `[fields]` — value counts across all matches | `facets` |
| `limit` / `offset` (or `pagination`) | page size / start | `pagination: { offset, limit }` |

Searches are POSTed as JSON (except `odp.bulk.search`, which the API only accepts
as GET query params and which therefore takes at most one filter and one range
filter — put further conditions in `q`). Responses carry `count` (total matches), a `*DataBag` array
of records, and `facets` when requested. Field paths are relative to the record:
for patents, `applicationNumberText`, `applicationMetaData.inventionTitle`,
`applicationMetaData.filingDate`, `applicationMetaData.patentNumber`, …

```js
await odp.patents.search({
  q: 'applicationMetaData.inventionTitle:"solid state battery"',
  rangeFilters: { 'applicationMetaData.filingDate': ['2023-01-01', '2024-12-31'] },
  sort: 'applicationMetaData.filingDate desc',
  fields: ['applicationNumberText', 'applicationMetaData.inventionTitle', 'applicationMetaData.filingDate'],
  limit: 25,
});
```

## Identifiers

- **Application numbers** accept display forms — `'17248024'`, `'17/248,024'`,
  `'US 17/248,024'` — and PCT numbers (`'PCT/US2024/012345'` → `'PCTUS2024012345'`).
  Anything else throws `TypeError` before any request.
- **Patent numbers** are different identifiers: resolve them with
  `odp.patents.byPatentNumber` (accepts `'11,000,000'`, `'US11000000B2'`, `'D987654'`).
- **PTAB** trial numbers look like `'IPR2021-01599'`; appeal numbers like
  `'2023001234'`; interference numbers are 6 digits.
- **TSDR case ids**: `'sn'` + 8-digit serial (`'sn97123456'`), `'rn'` + registration
  number (`'rn6123456'`), `'ref'` + Madrid reference number (letters and digits,
  case kept: `'refZ1231384'`), or `'ir'` + international registration number. A bare
  8-digit number is a serial number; 7 or fewer digits a registration number.
- **Other ids** (document and record identifiers, product ids) must be letters,
  digits, `-`, `_` and `.`, starting with a letter or digit — exactly as the API
  returns them. Anything else (for example `..`) throws `TypeError` before any
  request.
- **Office-action rejection grounds** (`rejectionTypeBag`) are statute sections as
  strings: `'101'`, `'102'`, `'103'`, `'112'`.

## Errors

An SDK call that fails throws an `Error` whose `name` is below and whose `status`
carries the HTTP code where there is one. Uncaught, it ends the execution: the
`execute` result is `{ ok: false, error: { name, message, status? }, logs }`, sent
with `isError: true`. Use `try/catch` to handle it inline.

| `name` | Meaning |
|---|---|
| `SourceUnavailable` | The source has no API key (or, in account mode, you haven't saved one). |
| `TypeError` | Bad argument (malformed application number, unknown method) — no request was made. |
| `NotFound` | Upstream `404`. |
| `Unauthorized` | Upstream `401`/`403`: key missing, invalid, or not allowed. |
| `RateLimited` | Upstream `429` (every caller of the key is paused for at least 5 s, or `Retry-After`), the key's queue is full, or the hourly budget is used up. Don't retry immediately. |
| `CallBudgetExceeded` | This `execute()` hit its per-source call budget (ODP 50, TSDR 25). |
| `SubjectQuotaExceeded` | Your hourly per-subject quota on this server is used up. |
| `ResponseTooLarge` | An upstream response exceeded 8 MiB — use `fields` and a smaller `limit`. |
| `ArgumentsTooLarge` / `TooManyPendingCalls` | One SDK call's arguments exceeded 64 KiB / more than 16 calls were pending at once. |
| `HttpError` | Any other upstream error; `status` carries the HTTP code, and the message includes USPTO's error detail. |

Execution-level errors (in the `execute` result, not thrown by SDK calls):
`ResultTooLarge` (the returned value is over 256 KiB — return less), `CodeTooLarge`
(over 256 KiB of code), `TimeoutError`, `AbortError` (the client cancelled or the
server is shutting down), `Busy` (too many executions running), `PolicyError`
(the code uses a banned construct, or TypeScript syntax), and `SandboxUnavailable`.
Logs are capped at 64 KiB / 1,000 lines (`[logs truncated]`).

## Limits

USPTO serves **one request at a time per API key**, so calls queue (ODP at most
4/s, TSDR 1/s) and `Promise.all` does not speed things up. Fetch fewer, larger pages
with `fields`, and return only what you need. See
[architecture.md](./architecture.md#rate-limits-and-guardrails).

Not available from the sandbox: document PDFs, bulk files, PTAB file downloads and
`search/download` CSV exports. Methods return their URLs.

## Method reference

<!-- BEGIN GENERATED: method reference (scripts/gen-sdk-reference.mjs) -->

_Generated from `schema/odp.json` and `schema/tsdr.json`; edit those, then run `node scripts/gen-sdk-reference.mjs`._

### `odp.patents`

#### `odp.patents.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search patent applications and granted patents (Patent File Wrapper) by keyword, invention title, inventor, applicant, filing or grant date, CPC class, examiner, art unit, status or patent number. Each record holds applicationMetaData plus continuity, assignments, PTA, attorneys and transactions; use fields to return only what you need. Returns { count, patentFileWrapperDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
await odp.patents.search({ q: 'applicationMetaData.inventionTitle:battery', rangeFilters: { 'applicationMetaData.filingDate': ['2024-01-01', '2024-03-31'] }, sort: 'applicationMetaData.filingDate desc', fields: ['applicationNumberText', 'applicationMetaData.inventionTitle', 'applicationMetaData.filingDate', 'applicationMetaData.patentNumber', 'applicationMetaData.applicationStatusDescriptionText'], facets: ['applicationMetaData.applicationTypeLabelName'], limit: 5 })
```

#### `odp.patents.get(applicationNumber)`

Full Patent File Wrapper record for one application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'): applicationMetaData (title, status, dates, patentNumber, inventors, applicants, CPC, examiner, art unit), continuity, assignments, attorney, PTA, transactions (eventDataBag), pgpub/grant document metadata. Large: prefer patents.search with fields when you need a few attributes.

```js
const r = await odp.patents.get('17/248,024'); return r.patentFileWrapperDataBag[0].applicationMetaData
```

#### `odp.patents.byPatentNumber(patentNumber, { fields? })`

Find the application behind a granted patent number ('11,000,000', 'US11000000B2', 'D987654', 'RE49999'). Runs patents.search on applicationMetaData.patentNumber and returns the same shape (count 0 if not found). Use the returned applicationNumberText with the other patents.* methods.

```js
const r = await odp.patents.byPatentNumber('US 11,234,567 B2', { fields: ['applicationNumberText', 'applicationMetaData.inventionTitle'] }); return r.patentFileWrapperDataBag[0]
```

#### `odp.patents.metaData(applicationNumber)`

Application metadata only (applicationMetaData: title, status, filing/grant dates, inventors, applicants, CPC, examiner, art unit, entity status) for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.metaData('17248024')
```

#### `odp.patents.adjustment(applicationNumber)`

Patent Term Adjustment data (patentTermAdjustmentData: A/B/C delays, applicant delay, total adjustment days, PTA history) for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.adjustment('17248024')
```

#### `odp.patents.assignment(applicationNumber)`

Recorded assignments (assignmentBag: reel/frame, conveyance, assignors, assignees, recorded/execution dates) for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.assignment('17248024')
```

#### `odp.patents.attorney(applicationNumber)`

Attorney/agent of record and correspondence address (recordAttorney: customer number, power of attorney, practitioners with registration numbers) for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.attorney('17248024')
```

#### `odp.patents.continuity(applicationNumber)`

Continuity: parentContinuityBag (parents: continuation/divisional/CIP/provisional claims) and childContinuityBag for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.continuity('17248024')
```

#### `odp.patents.foreignPriority(applicationNumber)`

Foreign priority claims (foreignPriorityBag: country, application number, filing date) for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.foreignPriority('17248024')
```

#### `odp.patents.transactions(applicationNumber)`

Prosecution transaction history (eventDataBag: eventCode, eventDescriptionText, eventDate) — the file-wrapper timeline for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.transactions('17248024')
```

#### `odp.patents.documents(applicationNumber, { documentCodes?: string | string[], officialDateFrom?: 'YYYY-MM-DD', officialDateTo? })`

List the documents in an application's file wrapper (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'): documentBag[] with documentIdentifier, documentCode (e.g. CTNF non-final rejection, CTFR final rejection, NOA notice of allowance, CLM claims, SPEC, ABST, REM applicant remarks, IDS), documentCodeDescriptionText, officialDate, and downloadOptionBag[] (PDF/XML/DOCX URLs + page counts). Downloads themselves are not available in the sandbox; return the URLs. Counts against the separate 1.2M/week documents quota.

```js
const r = await odp.patents.documents('17248024', { documentCodes: ['CTNF', 'CTFR', 'NOA'] }); return r.documentBag.map(d => ({ code: d.documentCode, date: d.officialDate, desc: d.documentCodeDescriptionText, pages: d.downloadOptionBag?.[0]?.pageTotalQuantity }))
```

#### `odp.patents.associatedDocuments(applicationNumber)`

Associated pre-grant publication and grant full-text documents (pgpubDocumentMetaData / grantDocumentMetaData: XML file names, product identifiers, download URIs in the bulk XML datasets) for one patent application (applicationNumber: string — '17248024', '17/248,024', 'US 17/248,024', or a PCT number like 'PCT/US2024/012345'). Returns { count, patentFileWrapperDataBag: [record] } with only this section populated.

```js
await odp.patents.associatedDocuments('17248024')
```

#### `odp.patents.statusCodes({ q?, offset?, limit? } | q-string)`

Look up application status codes and descriptions (statusCodeBag: applicationStatusCode, applicationStatusDescriptionText), e.g. to translate applicationMetaData.applicationStatusCode or to find the code for 'Patented Case' (150) or 'Abandoned'.

```js
await odp.patents.statusCodes({ q: 'applicationStatusDescriptionText:abandoned', limit: 50 })
```

### `odp.ptab.proceedings`

#### `odp.ptab.proceedings.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search PTAB AIA trial proceedings (IPR, PGR, CBM, DER): trialNumber, trialMetaData (trialTypeCode, trialStatusCategory, petitionFilingDate, institutionDecisionDate, terminationDate), patentOwnerData (patentNumber, applicationNumberText, technology center), regularPetitionerData (realPartyInInterestName, counselName). Returns { count, patentTrialProceedingDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
await odp.ptab.proceedings.search({ q: 'patentOwnerData.patentNumber:9876543', fields: ['trialNumber', 'trialMetaData.trialTypeCode', 'trialMetaData.trialStatusCategory', 'trialMetaData.petitionFilingDate', 'regularPetitionerData.realPartyInInterestName'] })
```

#### `odp.ptab.proceedings.get(trialNumber)`

One PTAB trial proceeding by trial number (e.g. 'IPR2021-01599', 'PGR2023-00012'). Returns { patentTrialProceedingDataBag: [record] }.

```js
const t = await odp.ptab.proceedings.search({ fields: ['trialNumber'], limit: 1 }); return await odp.ptab.proceedings.get(t.patentTrialProceedingDataBag[0].trialNumber)
```

### `odp.ptab.decisions`

#### `odp.ptab.decisions.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search PTAB trial decisions (institution decisions, final written decisions, rehearing): decisionData (decisionTypeCategory, trialOutcomeCategory, decisionIssueDate, statuteAndRuleBag), documentData (documentName, documentTitleText, documentOCRText = full OCR text, fileDownloadURI), trialMetaData, patentOwnerData, regularPetitionerData. Returns { count, patentTrialDocumentDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
await odp.ptab.decisions.search({ rangeFilters: { 'decisionData.decisionIssueDate': ['2024-01-01', '2024-12-31'] }, facets: ['decisionData.trialOutcomeCategory'], fields: ['trialNumber', 'decisionData', 'documentData.documentTitleText', 'patentOwnerData.patentNumber'], limit: 10 })
```

#### `odp.ptab.decisions.get(documentIdentifier)`

One PTAB trial decision document by documentIdentifier (from decisions.search / byTrial). Includes documentData.documentOCRText (full text).

```js
const s = await odp.ptab.decisions.search({ fields: ['documentData.documentIdentifier'], limit: 1 }); const d = await odp.ptab.decisions.get(s.patentTrialDocumentDataBag[0].documentData.documentIdentifier); return d.patentTrialDocumentDataBag[0].documentData.documentOCRText.slice(0, 1500)
```

#### `odp.ptab.decisions.byTrial(trialNumber)`

All decision documents in one PTAB trial (e.g. 'IPR2021-01599'). Returns { count: 0, patentTrialDocumentDataBag: [] } when the trial has no decisions yet.

```js
const s = await odp.ptab.decisions.search({ fields: ['trialNumber'], limit: 1 }); const r = await odp.ptab.decisions.byTrial(s.patentTrialDocumentDataBag[0].trialNumber); return r.patentTrialDocumentDataBag.map(d => ({ id: d.documentData.documentIdentifier, type: d.decisionData?.decisionTypeCategory, outcome: d.decisionData?.trialOutcomeCategory, date: d.decisionData?.decisionIssueDate }))
```

### `odp.ptab.documents`

#### `odp.ptab.documents.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search all PTAB trial papers and exhibits (petitions, patent owner responses, exhibits, orders): documentData (documentCategory, filingPartyCategory PETITIONER/PATENT OWNER/BOARD, documentTitleText, documentOCRText, documentFilingDate, fileDownloadURI). Returns { count, patentTrialDocumentDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
const s = await odp.ptab.proceedings.search({ fields: ['trialNumber'], limit: 1 }); return await odp.ptab.documents.search({ q: `trialNumber:${s.patentTrialProceedingDataBag[0].trialNumber}`, fields: ['documentData.documentIdentifier', 'documentData.documentTitleText', 'documentData.documentFilingDate', 'documentData.filingPartyCategory'], limit: 25 })
```

#### `odp.ptab.documents.get(documentIdentifier)`

One PTAB trial document by documentIdentifier, with documentOCRText.

```js
const s = await odp.ptab.documents.search({ fields: ['documentData.documentIdentifier'], limit: 1 }); const d = await odp.ptab.documents.get(s.patentTrialDocumentDataBag[0].documentData.documentIdentifier); return d.patentTrialDocumentDataBag[0].documentData.documentTitleText
```

#### `odp.ptab.documents.byTrial(trialNumber)`

All papers and exhibits in one PTAB trial. Can be large (OCR text included): prefer documents.search with fields when you only need the list.

```js
const s = await odp.ptab.proceedings.search({ fields: ['trialNumber'], limit: 1 }); const r = await odp.ptab.documents.byTrial(s.patentTrialProceedingDataBag[0].trialNumber); return r.patentTrialDocumentDataBag.map(d => d.documentData.documentTitleText)
```

### `odp.ptab.appeals`

#### `odp.ptab.appeals.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search PTAB ex parte appeal decisions (appeals from examiner rejections): appealNumber, appealMetaData, appellantData (applicationNumberText, patentNumber, technology center), decisionData (appealOutcomeCategory e.g. Affirmed / Reversed, decisionIssueDate, issueTypeBag e.g. '103', statuteAndRuleBag), documentData (documentOCRText). Returns { count, patentAppealDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
await odp.ptab.appeals.search({ q: 'decisionData.appealOutcomeCategory:Reversed', fields: ['appealNumber', 'decisionData.decisionIssueDate', 'appellantData.applicationNumberText'], sort: 'decisionData.decisionIssueDate desc', limit: 10 })
```

#### `odp.ptab.appeals.get(documentIdentifier)`

One PTAB appeal decision document by documentIdentifier.

```js
const s = await odp.ptab.appeals.search({ fields: ['documentData.documentIdentifier'], limit: 1 }); return await odp.ptab.appeals.get(s.patentAppealDataBag[0].documentData.documentIdentifier)
```

#### `odp.ptab.appeals.byAppeal(appealNumber)`

All decisions for one appeal number (e.g. '2023001234').

```js
const s = await odp.ptab.appeals.search({ fields: ['appealNumber'], limit: 1 }); return await odp.ptab.appeals.byAppeal(s.patentAppealDataBag[0].appealNumber)
```

### `odp.ptab.interferences`

#### `odp.ptab.interferences.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search PTAB interference decisions (pre-AIA priority contests): interferenceNumber, interferenceMetaData, seniorPartyData, juniorPartyData, additionalPartyDataBag, documentData. Returns { count, patentInterferenceDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
await odp.ptab.interferences.search({ fields: ['interferenceNumber', 'documentData.documentIdentifier', 'documentData.documentTitleText'], limit: 10 })
```

#### `odp.ptab.interferences.get(documentIdentifier)`

One interference decision document by documentIdentifier.

```js
const s = await odp.ptab.interferences.search({ fields: ['documentData.documentIdentifier'], limit: 1 }); return await odp.ptab.interferences.get(s.patentInterferenceDataBag[0].documentData.documentIdentifier)
```

#### `odp.ptab.interferences.byInterference(interferenceNumber)`

All decisions for one interference number (e.g. '105970').

```js
const s = await odp.ptab.interferences.search({ fields: ['interferenceNumber'], limit: 1 }); return await odp.ptab.interferences.byInterference(s.patentInterferenceDataBag[0].interferenceNumber)
```

### `odp.petitions`

#### `odp.petitions.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search final petition decisions from the Office of Petitions and Technology Centers (revival of abandoned applications, reinstated patents after late maintenance fees, delayed priority claims, make special, PTA reconsideration...): applicationNumberText, patentNumber, decisionPetitionTypeCode + decisionPetitionTypeCodeDescriptionText (what was petitioned, often with the 37 CFR rule), decidedPetitionTypeCode + decidedPetitionTypeCodeDescriptionText (outcome, e.g. GRANTED / DENIED / DISMISSED), petitionMailDate, decisionDate, decisionMailDate, finalDecidingOfficeName, technologyCenter, groupArtUnitNumber, ocrSearchText (decision text), documentBag. Returns { count, petitionDecisionDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
await odp.petitions.search({ q: 'decidedPetitionTypeCodeDescriptionText:GRANTED', rangeFilters: { decisionDate: ['2025-01-01', '2025-12-31'] }, facets: ['decisionPetitionTypeCodeDescriptionText'], fields: ['petitionDecisionRecordIdentifier', 'applicationNumberText', 'decisionPetitionTypeCodeDescriptionText', 'decisionDate'], limit: 10 })
```

#### `odp.petitions.get(petitionDecisionRecordIdentifier)`

One petition decision by petitionDecisionRecordIdentifier (from petitions.search), including documentBag (decision documents with download URLs) and ocrSearchText.

```js
const s = await odp.petitions.search({ fields: ['petitionDecisionRecordIdentifier'], limit: 1 }); const r = await odp.petitions.get(s.petitionDecisionDataBag[0].petitionDecisionRecordIdentifier); return r.petitionDecisionDataBag[0].decidedPetitionTypeCodeDescriptionText
```

### `odp.officeActions`

#### `odp.officeActions.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search office actions (full text) issued by examiners for public applications filed 2001+: applicationNumberText, documentCode (CTNF non-final, CTFR final, CTRS restriction, NOA...), documentCodeDescriptionText, submissionDate, groupArtUnitNumber, patentNumber, rejectionTypeBag (statute sections as strings: '101', '102', '103', '112'), officeActionText, officeActionRecordIdentifier. This is the current Office Action Search API; prefer it over the legacy odp.oa.* DSAPI endpoints. Returns { count, officeActionDataBag: [...] }. Params: q, filters, rangeFilters, sort, fields, facets, limit, offset (see odp.syntax.search).

```js
await odp.officeActions.search({ q: 'documentCode:CTNF AND rejectionTypeBag:103', fields: ['officeActionRecordIdentifier', 'applicationNumberText', 'submissionDate', 'rejectionTypeBag'], sort: 'submissionDate desc', limit: 10 })
```

#### `odp.officeActions.get(officeActionRecordIdentifier)`

One office action record by officeActionRecordIdentifier (from officeActions.search), including officeActionText.

```js
const s = await odp.officeActions.search({ fields: ['officeActionRecordIdentifier'], limit: 1 }); return await odp.officeActions.get(s.officeActionDataBag[0].officeActionRecordIdentifier)
```

#### `odp.officeActions.text(officeActionRecordIdentifier)`

The full text of one office action as a plain string. Long: slice or search it in the sandbox and return only the relevant passages.

```js
const s = await odp.officeActions.search({ q: 'rejectionTypeBag:103', fields: ['officeActionRecordIdentifier'], limit: 1 }); const t = await odp.officeActions.text(s.officeActionDataBag[0].officeActionRecordIdentifier); const i = t.indexOf('103'); return t.slice(Math.max(0, i - 200), i + 1500)
```

### `odp.oa.text`

#### `odp.oa.text.search(criteria: Lucene/Solr query string (default '*:*'), { start?: number, rows?: 1-1000 (default 25) })`

LEGACY Office Action DSAPI — office action full text, with section-level fields (e.g. bodyText, sections.*). Returns { response: { numFound, start, docs: [...] } }. Criteria uses this dataset's own field names (see odp.oa.text.fields and odp.fields.oa.text); application numbers are digits only, e.g. patentApplicationNumber:16123456.

```js
await odp.oa.text.search('patentApplicationNumber:16123456', { rows: 10 })
```

#### `odp.oa.text.fields()`

LEGACY DSAPI field list and dataset info for odp.oa.text.search (field names usable in criteria).

```js
await odp.oa.text.fields()
```

### `odp.oa.citations`

#### `odp.oa.citations.search(criteria: Lucene/Solr query string (default '*:*'), { start?: number, rows?: 1-1000 (default 25) })`

LEGACY Office Action DSAPI — references cited by examiners in office actions (form PTO-892 and in-text citations). Returns { response: { numFound, start, docs: [...] } }. Criteria uses this dataset's own field names (see odp.oa.citations.fields and odp.fields.oa.citations); application numbers are digits only, e.g. patentApplicationNumber:16123456.

```js
await odp.oa.citations.search('patentApplicationNumber:16123456')
```

#### `odp.oa.citations.fields()`

LEGACY DSAPI field list and dataset info for odp.oa.citations.search (field names usable in criteria).

```js
await odp.oa.citations.fields()
```

### `odp.oa.rejections`

#### `odp.oa.rejections.search(criteria: Lucene/Solr query string (default '*:*'), { start?: number, rows?: 1-1000 (default 25) })`

LEGACY Office Action DSAPI — per-claim rejection data parsed from office actions (101/102/103/112 flags, rejected claims, action type). Returns { response: { numFound, start, docs: [...] } }. Criteria uses this dataset's own field names (see odp.oa.rejections.fields and odp.fields.oa.rejections); application numbers are digits only, e.g. patentApplicationNumber:16123456.

```js
await odp.oa.rejections.search('hasRej103:1', { rows: 10 })
```

#### `odp.oa.rejections.fields()`

LEGACY DSAPI field list and dataset info for odp.oa.rejections.search (field names usable in criteria).

```js
await odp.oa.rejections.fields()
```

### `odp.oa.enrichedCitations`

#### `odp.oa.enrichedCitations.search(criteria: Lucene/Solr query string (default '*:*'), { start?: number, rows?: 1-1000 (default 25) })`

LEGACY Office Action DSAPI — enriched cited-reference metadata (cited document, relevant claims/passages, examiner vs applicant citation). Returns { response: { numFound, start, docs: [...] } }. Criteria uses this dataset's own field names (see odp.oa.enrichedCitations.fields and odp.fields.oa.enrichedCitations); application numbers are digits only, e.g. patentApplicationNumber:16123456.

```js
await odp.oa.enrichedCitations.search('patentApplicationNumber:16123456')
```

#### `odp.oa.enrichedCitations.fields()`

LEGACY DSAPI field list and dataset info for odp.oa.enrichedCitations.search (field names usable in criteria).

```js
await odp.oa.enrichedCitations.fields()
```

### `odp.bulk`

#### `odp.bulk.search(params: { q?, filters?, rangeFilters?, sort?, fields?, facets?, limit?, offset? } | q-string)`

Search the bulk dataset catalog (bulkDataProductBag[]: productIdentifier e.g. PTGRXML patent grant full text, TRTDXFAP trademark full text, OACT office action weekly archives, plus PatentsView tables; productTitleText, productDescriptionText, productFrequencyText, date range, file counts). At most one filter and one rangeFilter (GET-only endpoint); put further conditions in q. Catalog metadata only: bulk files cannot be downloaded from the sandbox.

```js
await odp.bulk.search({ q: 'patent grant full text', fields: ['productIdentifier', 'productTitleText', 'productFrequencyText'], limit: 20 })
```

#### `odp.bulk.get(productIdentifier, { fileDataFromDate?, fileDataToDate?, offset?, limit?, includeFiles?: boolean, latest?: boolean })`

One bulk dataset product with its file list (productFileBag.fileDataBag[]: fileName, fileSize, fileDataFromDate/ToDate, fileReleaseDate, fileDownloadURI). Use latest: true or a date window to keep the file list small. Downloads are not available in the sandbox; return the URIs.

```js
await odp.bulk.get('PTGRXML', { latest: true })
```

### `tsdr`

#### `tsdr.status(caseId)`

Trademark case status and bibliographic data as JSON ({ trademarks: [ { status: { markElement (the mark text), status (code), extStatusDesc / tm5StatusDesc (status text), filingDate, usRegistrationNumber, ... }, parties: { ownerGroups (keyed by party type code) }, gsList (goods & services by class), prosecutionHistory (events), publication, divisional, internationalData } ] }). caseId: 'sn' + 8-digit serial ('sn97123456'), 'rn' + registration number ('rn6123456'), 'ref' + Madrid reference number ('refZ1231384'), 'ir' + international registration number; a bare 8-digit number is a serial number.

```js
const r = await tsdr.status('sn97123456'); const t = r.trademarks[0]; return { mark: t.status.markElement, status: t.status.tm5StatusDesc, detail: t.status.extStatusDesc, filed: t.status.filingDate, classes: t.gsList?.map(g => g.primeClassCode) }
```

#### `tsdr.multiStatus(type: 'sn' | 'rn' | 'ref' | 'ir', ids: string[] /* 1-25 */)`

Status for up to 25 trademark cases of one number type in one call (counts as one request). Returns { size, transactionList: [ { searchId, trademarks: [...] } ] } with the same record shape as tsdr.status.

```js
await tsdr.multiStatus('sn', ['97123456', '97123457'])
```

#### `tsdr.documents(caseId)`

The trademark case's document list (applications, office actions, responses, registration certificates, specimens) as XML text, one entry per document with its type, mail/received date, document id and page URLs. Parse with string methods / regex in the sandbox and return a summary; PDFs cannot be downloaded from the sandbox. Inspect a slice of the XML first to see the element names.

```js
const xml = await tsdr.documents('sn97123456'); return xml.slice(0, 3000)
```

#### `tsdr.documentInfo(caseId, documentId)`

Metadata for one document in a trademark case (XML text), e.g. page count and media types. documentId comes from tsdr.documents.

```js
const xml = await tsdr.documents('sn97123456'); const id = (xml.match(/<DocumentIdentifier>([^<]+)</) ?? [])[1]; return id ? await tsdr.documentInfo('sn97123456', id) : xml.slice(0, 2000)
```

#### `tsdr.lastUpdate(serialNumber)`

When a trademark case's prosecution history last changed (caseUpdateInfo). Serial numbers only. Cheap way to check whether a cached status is stale.

```js
await tsdr.lastUpdate('97123456')
```

<!-- END GENERATED: method reference -->
