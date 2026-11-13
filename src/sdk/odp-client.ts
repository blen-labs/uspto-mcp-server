import { HttpClient, HttpError } from '../util/httpClient.js';

/**
 * USPTO Open Data Portal (api.uspto.gov). Every search endpoint accepts the same JSON body;
 * see https://data.uspto.gov/apis/api-syntax-examples.
 */
export interface OdpFilter { name: string; value: string | string[] }
export interface OdpRangeFilter { field: string; valueFrom: string | number; valueTo: string | number }
export interface OdpSort { field: string; order?: 'asc' | 'desc' | 'Asc' | 'Desc' }

export interface OdpSearch {
  /** Lucene-style query: 'inventionTitle:"machine learning" AND applicationMetaData.filingDate:[2024-01-01 TO 2024-12-31]'. */
  q?: string;
  /** Exact-match filters. Either the API's list form, or a map of field -> value(s). */
  filters?: OdpFilter[] | Record<string, string | string[]>;
  /** Inclusive ranges. Either the API's list form, or a map of field -> [from, to]. */
  rangeFilters?: OdpRangeFilter[] | Record<string, [string | number, string | number]>;
  /** 'field desc', a list of those, or the API's [{ field, order }] form. */
  sort?: string | string[] | OdpSort[];
  /** Return only these fields (dotted paths). Strongly recommended: full records are large. */
  fields?: string[];
  /** Count values of these fields across all matches. */
  facets?: string[];
  pagination?: { offset?: number; limit?: number };
  /** Shorthand for pagination.offset / pagination.limit. */
  offset?: number;
  limit?: number;
}

type Body = Record<string, unknown>;

/** Normalize the convenience forms into the JSON body every ODP search endpoint accepts. */
export function toSearchBody(input: OdpSearch | string = {}): Body {
  const s: OdpSearch = typeof input === 'string' ? { q: input } : (input ?? {});
  if (typeof s !== 'object' || Array.isArray(s)) throw new TypeError('search params must be an object or a query string');
  const body: Body = {};
  if (s.q !== undefined && s.q !== null && String(s.q).trim()) body.q = String(s.q);
  if (s.filters) {
    body.filters = Array.isArray(s.filters)
      ? s.filters.map(f => ({ name: f.name, value: Array.isArray(f.value) ? f.value.map(String) : [String(f.value)] }))
      : Object.entries(s.filters).map(([name, v]) => ({ name, value: Array.isArray(v) ? v.map(String) : [String(v)] }));
  }
  if (s.rangeFilters) {
    body.rangeFilters = Array.isArray(s.rangeFilters)
      ? s.rangeFilters.map(r => ({ field: r.field, valueFrom: String(r.valueFrom), valueTo: String(r.valueTo) }))
      : Object.entries(s.rangeFilters).map(([field, [from, to]]) => ({ field, valueFrom: String(from), valueTo: String(to) }));
  }
  if (s.sort) {
    const list = Array.isArray(s.sort) ? s.sort : [s.sort];
    body.sort = list.map(item => {
      if (typeof item === 'string') {
        const [field, order] = item.trim().split(/\s+/);
        return { field, order: (order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc' };
      }
      return { field: item.field, order: (item.order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc' };
    });
  }
  if (s.fields?.length) body.fields = [...s.fields];
  if (s.facets?.length) body.facets = [...s.facets];
  const offset = s.pagination?.offset ?? s.offset;
  const limit = s.pagination?.limit ?? s.limit;
  if (offset !== undefined || limit !== undefined) {
    body.pagination = { offset: offset ?? 0, limit: limit ?? 25 };
  }
  return body;
}

/**
 * GET-style query params for the endpoints that only accept GET (bulk datasets search).
 * Filters use the API's "field value1,value2" string form.
 */
export function toSearchQuery(input: OdpSearch | string = {}): Record<string, string | number | undefined> {
  const body = toSearchBody(input);
  const out: Record<string, string | number | undefined> = {};
  if (body.q) out.q = body.q as string;
  const sort = body.sort as { field: string; order: string }[] | undefined;
  if (sort?.length) out.sort = sort.map(s => `${s.field} ${s.order.toLowerCase()}`).join(',');
  const page = body.pagination as { offset: number; limit: number } | undefined;
  if (page) { out.offset = page.offset; out.limit = page.limit; }
  if (body.facets) out.facets = (body.facets as string[]).join(',');
  if (body.fields) out.fields = (body.fields as string[]).join(',');
  // The GET form documents one "field value1,value2" filter and one "field from:to" range;
  // how several combine is undocumented, so refuse rather than guess.
  const filters = body.filters as { name: string; value: string[] }[] | undefined;
  const ranges = body.rangeFilters as { field: string; valueFrom: string; valueTo: string }[] | undefined;
  if ((filters?.length ?? 0) > 1 || (ranges?.length ?? 0) > 1) {
    throw new TypeError('This endpoint accepts at most one filter and one rangeFilter; express further conditions in q (e.g. "productFrequencyText:WEEKLY AND ...").');
  }
  if (filters?.length) out.filters = `${filters[0]!.name} ${filters[0]!.value.join(',')}`;
  if (ranges?.length) out.rangeFilters = `${ranges[0]!.field} ${ranges[0]!.valueFrom}:${ranges[0]!.valueTo}`;
  return out;
}

/**
 * Accepts '17/248,024', 'US 17248024', '17248024', and PCT forms ('PCT/US2024/012345',
 * 'PCTUS2024012345'); returns the form the ODP path parameter expects.
 */
export function normalizeApplicationNumber(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('applicationNumber must be a string');
  const raw = String(value).trim().toUpperCase();
  const pct = raw.replace(/[\s/,-]/g, '');
  if (pct.startsWith('PCT')) {
    if (!/^PCT[A-Z]{2}\d{4}\d{6}$/.test(pct)) throw new TypeError(`Unrecognized PCT application number '${value}'`);
    return pct;
  }
  const digits = raw.replace(/^US/, '').replace(/[\s/,.-]/g, '');
  if (!/^\d{6,12}$/.test(digits)) throw new TypeError(`Unrecognized application number '${value}'. Pass the application number (e.g. '17248024' or '17/248,024'); for a patent or publication number use odp.patents.byPatentNumber or odp.patents.search.`);
  return digits;
}

/**
 * Path segment for an identifier (trial/appeal/interference numbers, document and record ids,
 * product ids). Letters, digits, '-', '_' and '.', starting with a letter or digit, so a value can
 * never be a dot segment ('.', '..') or contain a separator that changes the endpoint.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
function segment(value: unknown, what: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`${what} must be a string`);
  const v = String(value).trim();
  if (!ID.test(v)) throw new TypeError(`Invalid ${what} '${v.slice(0, 50)}': use the identifier exactly as the API returns it (letters, digits, '-', '_', '.').`);
  return v;
}

/**
 * ODP answers a query with no hits with HTTP 404 and a "No matching records found" body (verified live
 * 2026-11-12) instead of `count: 0`. For searches and list endpoints that is an empty result, not an
 * error; get-by-id keeps NotFound.
 */
export function isNoMatches(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404 && /no matching records/i.test(err.bodySnippet);
}

async function emptyOnNoMatches<T>(bag: string, run: () => Promise<T>): Promise<T | { count: 0; [bag: string]: unknown }> {
  try {
    return await run();
  } catch (err) {
    if (isNoMatches(err)) return { count: 0, [bag]: [] };
    throw err;
  }
}

/** Office Action (DSAPI, legacy) paging + Lucene/Solr criteria. */
export interface DsapiParams { start?: number; rows?: number }

export class OdpClient {
  constructor(private readonly http: HttpClient) {}

  private search(path: string, bag: string, params?: OdpSearch | string) {
    const body = toSearchBody(params);
    return emptyOnNoMatches(bag, () => this.http.call({ method: 'POST', path, body, cacheable: true }));
  }
  private list(path: string, bag: string) {
    return emptyOnNoMatches(bag, () => this.http.call({ path }));
  }
  private get(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.http.call({ path, query });
  }
  private app(applicationNumber: unknown, suffix = '') {
    return this.get(`/api/v1/patent/applications/${normalizeApplicationNumber(applicationNumber)}${suffix}`);
  }

  patents = {
    search: (params?: OdpSearch | string) => this.search('/api/v1/patent/applications/search', 'patentFileWrapperDataBag', params),
    get: (applicationNumber: string) => this.app(applicationNumber),
    metaData: (applicationNumber: string) => this.app(applicationNumber, '/meta-data'),
    adjustment: (applicationNumber: string) => this.app(applicationNumber, '/adjustment'),
    assignment: (applicationNumber: string) => this.app(applicationNumber, '/assignment'),
    attorney: (applicationNumber: string) => this.app(applicationNumber, '/attorney'),
    continuity: (applicationNumber: string) => this.app(applicationNumber, '/continuity'),
    foreignPriority: (applicationNumber: string) => this.app(applicationNumber, '/foreign-priority'),
    transactions: (applicationNumber: string) => this.app(applicationNumber, '/transactions'),
    documents: (applicationNumber: string, opts: { documentCodes?: string | string[]; officialDateFrom?: string; officialDateTo?: string } = {}) =>
      this.get(`/api/v1/patent/applications/${normalizeApplicationNumber(applicationNumber)}/documents`, {
        documentCodes: Array.isArray(opts.documentCodes) ? opts.documentCodes.join(',') : opts.documentCodes,
        officialDateFrom: opts.officialDateFrom, officialDateTo: opts.officialDateTo,
      }),
    associatedDocuments: (applicationNumber: string) => this.app(applicationNumber, '/associated-documents'),
    /** Resolve a granted patent number (e.g. '11,000,000' or 'US11000000B2') to its application record. */
    byPatentNumber: (patentNumber: string, opts: { fields?: string[] } = {}) => {
      if (typeof patentNumber !== 'string' && typeof patentNumber !== 'number') throw new TypeError('patentNumber must be a string');
      const n = String(patentNumber).toUpperCase().replace(/^US/, '').replace(/[\s,]/g, '').replace(/[A-Z]\d?$/, '');
      if (!/^(?:[A-Z]{1,2})?\d{4,8}$/.test(n)) throw new TypeError(`Unrecognized patent number '${patentNumber}'`);
      return this.search('/api/v1/patent/applications/search', 'patentFileWrapperDataBag', {
        q: `applicationMetaData.patentNumber:${n}`, pagination: { offset: 0, limit: 1 },
        ...(opts.fields ? { fields: opts.fields } : {}),
      });
    },
    statusCodes: (params: { q?: string; offset?: number; limit?: number } | string = {}) => {
      const p = typeof params === 'string' ? { q: params } : params;
      const body = { ...(p.q ? { q: p.q } : {}), pagination: { offset: p.offset ?? 0, limit: p.limit ?? 100 } };
      return emptyOnNoMatches('statusCodeBag', () => this.http.call({ method: 'POST', path: '/api/v1/patent/status-codes', cacheable: true, body }));
    },
  };

  ptab = {
    proceedings: {
      search: (params?: OdpSearch | string) => this.search('/api/v1/patent/trials/proceedings/search', 'patentTrialProceedingDataBag', params),
      get: (trialNumber: string) => this.get(`/api/v1/patent/trials/proceedings/${segment(trialNumber, 'trialNumber')}`),
    },
    decisions: {
      search: (params?: OdpSearch | string) => this.search('/api/v1/patent/trials/decisions/search', 'patentTrialDocumentDataBag', params),
      get: (documentIdentifier: string) => this.get(`/api/v1/patent/trials/decisions/${segment(documentIdentifier, 'documentIdentifier')}`),
      byTrial: (trialNumber: string) => this.list(`/api/v1/patent/trials/${segment(trialNumber, 'trialNumber')}/decisions`, 'patentTrialDocumentDataBag'),
    },
    documents: {
      search: (params?: OdpSearch | string) => this.search('/api/v1/patent/trials/documents/search', 'patentTrialDocumentDataBag', params),
      get: (documentIdentifier: string) => this.get(`/api/v1/patent/trials/documents/${segment(documentIdentifier, 'documentIdentifier')}`),
      byTrial: (trialNumber: string) => this.list(`/api/v1/patent/trials/${segment(trialNumber, 'trialNumber')}/documents`, 'patentTrialDocumentDataBag'),
    },
    appeals: {
      search: (params?: OdpSearch | string) => this.search('/api/v1/patent/appeals/decisions/search', 'patentAppealDataBag', params),
      get: (documentIdentifier: string) => this.get(`/api/v1/patent/appeals/decisions/${segment(documentIdentifier, 'documentIdentifier')}`),
      byAppeal: (appealNumber: string) => this.list(`/api/v1/patent/appeals/${segment(appealNumber, 'appealNumber')}/decisions`, 'patentAppealDataBag'),
    },
    interferences: {
      search: (params?: OdpSearch | string) => this.search('/api/v1/patent/interferences/decisions/search', 'patentInterferenceDataBag', params),
      get: (documentIdentifier: string) => this.get(`/api/v1/patent/interferences/decisions/${segment(documentIdentifier, 'documentIdentifier')}`),
      byInterference: (interferenceNumber: string) => this.list(`/api/v1/patent/interferences/${segment(interferenceNumber, 'interferenceNumber')}/decisions`, 'patentInterferenceDataBag'),
    },
  };

  petitions = {
    search: (params?: OdpSearch | string) => this.search('/api/v1/petition/decisions/search', 'petitionDecisionDataBag', params),
    /** The record includes documentBag (decision documents with download URLs); verified live. */
    get: (petitionDecisionRecordIdentifier: string) =>
      this.get(`/api/v1/petition/decisions/${segment(petitionDecisionRecordIdentifier, 'petitionDecisionRecordIdentifier')}`),
  };

  officeActions = {
    search: (params?: OdpSearch | string) => this.search('/api/v1/patent/office-action/search', 'officeActionDataBag', params),
    get: (officeActionRecordIdentifier: string) =>
      this.get(`/api/v1/patent/office-action/${segment(officeActionRecordIdentifier, 'officeActionRecordIdentifier')}`),
    /** Full office action text as a string. */
    text: (officeActionRecordIdentifier: string) => this.http.call({
      path: `/api/v1/patent/office-action/${segment(officeActionRecordIdentifier, 'officeActionRecordIdentifier')}/download/officeActionText`,
      accept: 'text',
    }),
  };

  /** Legacy Office Action APIs (DSAPI): Lucene/Solr `criteria`, `start`/`rows` paging, form-encoded. */
  private dsapi(dataset: string) {
    return {
      search: (criteria = '*:*', params: DsapiParams = {}) => {
        if (typeof criteria !== 'string') throw new TypeError('criteria must be a Lucene query string');
        const rows = params.rows ?? 25;
        if (!Number.isInteger(rows) || rows < 1 || rows > 1000) throw new RangeError('rows must be an integer between 1 and 1000');
        return this.http.call({
          method: 'POST', path: `/api/v1/patent/oa/${dataset}/records`, cacheable: true,
          form: { criteria: criteria.trim() || '*:*', start: params.start ?? 0, rows },
        });
      },
      fields: () => this.get(`/api/v1/patent/oa/${dataset}/fields`),
    };
  }

  oa = {
    text: this.dsapi('oa_actions/v1'),
    citations: this.dsapi('oa_citations/v2'),
    rejections: this.dsapi('oa_rejections/v2'),
    enrichedCitations: this.dsapi('enriched_cited_reference_metadata/v3'),
  };

  bulk = {
    search: (params?: OdpSearch | string) => {
      const query = toSearchQuery(params);
      return emptyOnNoMatches('bulkDataProductBag', () => this.get('/api/v1/datasets/products/search', query));
    },
    get: (productIdentifier: string, opts: { fileDataFromDate?: string; fileDataToDate?: string; offset?: number; limit?: number; includeFiles?: boolean; latest?: boolean } = {}) =>
      this.get(`/api/v1/datasets/products/${segment(productIdentifier, 'productIdentifier')}`, {
        fileDataFromDate: opts.fileDataFromDate, fileDataToDate: opts.fileDataToDate,
        offset: opts.offset, limit: opts.limit,
        includeFiles: opts.includeFiles === undefined ? undefined : String(opts.includeFiles),
        latest: opts.latest === undefined ? undefined : String(opts.latest),
      }),
  };
}
