import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { OdpClient, toSearchBody, toSearchQuery, normalizeApplicationNumber } from '../src/sdk/odp-client.js';
import { TsdrClient, normalizeCaseId } from '../src/sdk/tsdr-client.js';
import { HttpClient } from '../src/util/httpClient.js';
import { ODP_ORIGIN, TSDR_ORIGIN } from './helpers.js';

let agent: MockAgent;
beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
afterEach(async () => { await agent.close(); });

function http(extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({ baseUrl: ODP_ORIGIN, userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, dispatcher: agent, ...extra });
}
const odp = (extra = {}) => new OdpClient(http({ defaultHeaders: { 'X-API-KEY': 'odp-key' }, ...extra }));

describe('toSearchBody', () => {
  it('passes the API list forms through and normalizes shorthands', () => {
    expect(toSearchBody({
      q: 'battery',
      filters: { 'applicationMetaData.applicationTypeLabelName': 'Utility', x: ['a', 'b'] },
      rangeFilters: { 'applicationMetaData.filingDate': ['2024-01-01', '2024-12-31'] },
      sort: ['applicationMetaData.filingDate desc', 'applicationNumberText asc'],
      fields: ['applicationNumberText'], facets: ['applicationMetaData.applicationStatusCode'],
      limit: 10, offset: 20,
    })).toEqual({
      q: 'battery',
      filters: [{ name: 'applicationMetaData.applicationTypeLabelName', value: ['Utility'] }, { name: 'x', value: ['a', 'b'] }],
      rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: '2024-01-01', valueTo: '2024-12-31' }],
      sort: [{ field: 'applicationMetaData.filingDate', order: 'desc' }, { field: 'applicationNumberText', order: 'asc' }],
      fields: ['applicationNumberText'], facets: ['applicationMetaData.applicationStatusCode'],
      pagination: { offset: 20, limit: 10 },
    });
    expect(toSearchBody('battery')).toEqual({ q: 'battery' });
    expect(toSearchBody({ filters: [{ name: 'a', value: 'b' }], sort: [{ field: 'f' }] }))
      .toEqual({ filters: [{ name: 'a', value: ['b'] }], sort: [{ field: 'f', order: 'desc' }] });
    expect(toSearchBody()).toEqual({});
  });

  it('builds the GET query form for GET-only searches', () => {
    expect(toSearchQuery({ q: 'grant', filters: { productFrequencyText: 'WEEKLY' }, rangeFilters: { productFromDate: ['2020-01-01', '2021-01-01'] }, limit: 5 }))
      .toEqual({ q: 'grant', filters: 'productFrequencyText WEEKLY', rangeFilters: 'productFromDate 2020-01-01:2021-01-01', offset: 0, limit: 5 });
    expect(() => toSearchQuery({ filters: { a: 'x', b: 'y' } })).toThrow(/at most one filter/);
  });
});

describe('identifier normalization', () => {
  it('accepts display forms of application numbers', () => {
    expect(normalizeApplicationNumber('17/248,024')).toBe('17248024');
    expect(normalizeApplicationNumber('US 17/248,024')).toBe('17248024');
    expect(normalizeApplicationNumber(17248024)).toBe('17248024');
    expect(normalizeApplicationNumber('PCT/US2024/012345')).toBe('PCTUS2024012345');
  });
  it('rejects values that cannot be application numbers (no path injection)', () => {
    expect(() => normalizeApplicationNumber('../../datasets')).toThrow(TypeError);
    expect(() => normalizeApplicationNumber('17248024?x=1')).toThrow(TypeError);
    expect(() => normalizeApplicationNumber({})).toThrow(TypeError);
  });
  it('normalizes TSDR case ids', () => {
    expect(normalizeCaseId('97123456')).toBe('sn97123456');
    expect(normalizeCaseId('SN97123456')).toBe('sn97123456');
    expect(normalizeCaseId('6123456')).toBe('rn6123456');
    expect(normalizeCaseId('rn6123456')).toBe('rn6123456');
    expect(normalizeCaseId('refZ1231384')).toBe('refZ1231384'); // official TSDR guide example
    expect(normalizeCaseId('REFz1231384')).toBe('refz1231384');
    expect(normalizeCaseId('IR1234567')).toBe('ir1234567');
    expect(() => normalizeCaseId('sn97/../x')).toThrow(TypeError);
    expect(() => normalizeCaseId('ref..')).toThrow(TypeError);
  });
});

describe('OdpClient', () => {
  it('POSTs patent searches as JSON with the API key header', async () => {
    agent.get(ODP_ORIGIN).intercept({
      path: '/api/v1/patent/applications/search', method: 'POST',
      headers: { 'x-api-key': 'odp-key', 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'battery', pagination: { offset: 0, limit: 5 } }),
    }).reply(200, { count: 1, patentFileWrapperDataBag: [{ applicationNumberText: '17248024' }] });
    const out = await odp().patents.search({ q: 'battery', limit: 5 }) as { count: number };
    expect(out.count).toBe(1);
  });

  it('passes document filters as query params', async () => {
    agent.get(ODP_ORIGIN).intercept({ path: '/api/v1/patent/applications/17248024/documents?documentCodes=CTNF%2CNOA&officialDateFrom=2023-01-01', method: 'GET' })
      .reply(200, { documentBag: [] });
    expect(await odp().patents.documents('17248024', { documentCodes: ['CTNF', 'NOA'], officialDateFrom: '2023-01-01' })).toEqual({ documentBag: [] });
  });

  it('resolves a patent number through search', async () => {
    agent.get(ODP_ORIGIN).intercept({
      path: '/api/v1/patent/applications/search', method: 'POST',
      body: JSON.stringify({ q: 'applicationMetaData.patentNumber:11234567', pagination: { offset: 0, limit: 1 } }),
    }).reply(200, { count: 1 });
    expect(await odp().patents.byPatentNumber('US 11,234,567 B2')).toEqual({ count: 1 });
    expect(() => odp().patents.byPatentNumber('not a number')).toThrow(TypeError);
  });

  it('rejects identifiers that could change the endpoint (dot segments, separators)', () => {
    for (const bad of ['..', '.', '../../datasets', 'a/b', 'a\\b', '%2e%2e', '', ' ', 'x'.repeat(201)]) {
      expect(() => odp().ptab.proceedings.get(bad), bad).toThrow(TypeError);
      expect(() => odp().bulk.get(bad), bad).toThrow(TypeError);
    }
    expect(() => new TsdrClient(http()).documentInfo('sn97123456', '..')).toThrow(TypeError);
  });

  it('returns office action text as a string', async () => {
    agent.get(ODP_ORIGIN).intercept({ path: '/api/v1/patent/office-action/rec-1/download/officeActionText', method: 'GET' })
      .reply(200, 'Claims 1-10 are rejected', { headers: { 'content-type': 'text/plain' } });
    expect(await odp().officeActions.text('rec-1')).toBe('Claims 1-10 are rejected');
  });

  it('sends legacy DSAPI searches form-encoded and validates rows', async () => {
    agent.get(ODP_ORIGIN).intercept({
      path: '/api/v1/patent/oa/oa_rejections/v2/records', method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'criteria=patentApplicationNumber%3A16123456&start=0&rows=50',
    }).reply(200, { response: { numFound: 0, start: 0, docs: [] } });
    expect(await odp().oa.rejections.search('patentApplicationNumber:16123456', { rows: 50 }))
      .toEqual({ response: { numFound: 0, start: 0, docs: [] } });
    expect(() => odp().oa.text.search('*:*', { rows: 5000 })).toThrow(RangeError);
  });
});

describe('ODP empty results (live behavior: 404 + "No matching records found")', () => {
  const NO_MATCH = { code: 404, error: 'Not Found', errorDetails: 'No matching records found, refine your search criteria and try again' };
  it('returns an empty result for searches and list endpoints', async () => {
    const pool = agent.get(ODP_ORIGIN);
    pool.intercept({ path: '/api/v1/patent/applications/search', method: 'POST' }).reply(404, NO_MATCH);
    pool.intercept({ path: '/api/v1/patent/trials/IPR2027-00035/decisions', method: 'GET' }).reply(404, NO_MATCH);
    pool.intercept({ path: '/api/v1/datasets/products/search?q=zzz', method: 'GET' }).reply(404, NO_MATCH);
    expect(await odp().patents.search('applicationNumberText:00000000')).toEqual({ count: 0, patentFileWrapperDataBag: [] });
    expect(await odp().ptab.decisions.byTrial('IPR2027-00035')).toEqual({ count: 0, patentTrialDocumentDataBag: [] });
    expect(await odp().bulk.search('zzz')).toEqual({ count: 0, bulkDataProductBag: [] });
  });
  it('keeps NotFound for get-by-id and for other 404 bodies', async () => {
    const pool = agent.get(ODP_ORIGIN);
    pool.intercept({ path: '/api/v1/patent/applications/99999999', method: 'GET' }).reply(404, NO_MATCH);
    pool.intercept({ path: '/api/v1/patent/applications/search', method: 'POST' }).reply(404, { message: 'Not Found' });
    await expect(odp().patents.get('99999999')).rejects.toMatchObject({ name: 'NotFound', status: 404 });
    await expect(odp().patents.search('x')).rejects.toMatchObject({ name: 'NotFound' });
  });
});

describe('TsdrClient', () => {
  const tsdr = () => new TsdrClient(new HttpClient({ baseUrl: TSDR_ORIGIN, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, dispatcher: agent, defaultHeaders: { 'USPTO-API-KEY': 'tsdr-key' } }));

  it('requests case status as JSON with the TSDR key header', async () => {
    agent.get(TSDR_ORIGIN).intercept({ path: '/ts/cd/casestatus/sn97123456/info', method: 'GET', headers: { 'usPTO-api-key': 'tsdr-key', accept: 'application/json' } })
      .reply(200, { trademarks: [{ status: { markElement: 'AZUKI ZEN' } }] });
    expect(await tsdr().status('97123456')).toEqual({ trademarks: [{ status: { markElement: 'AZUKI ZEN' } }] });
  });

  it('batches multiStatus and validates its inputs', async () => {
    agent.get(TSDR_ORIGIN).intercept({ path: '/ts/cd/caseMultiStatus/sn?ids=97123456%2C97123457', method: 'GET' }).reply(200, { size: 2 });
    expect(await tsdr().multiStatus('sn', ['97123456', '97123457'])).toEqual({ size: 2 });
    expect(() => tsdr().multiStatus('xx', ['1'])).toThrow(TypeError);
    expect(() => tsdr().multiStatus('sn', Array.from({ length: 26 }, (_, i) => String(i)))).toThrow(RangeError);
  });

  it('returns document lists as XML text', async () => {
    agent.get(TSDR_ORIGIN).intercept({ path: '/ts/cd/casedocs/sn97123456/info', method: 'GET' })
      .reply(200, '<DocumentList/>', { headers: { 'content-type': 'application/xml' } });
    expect(await tsdr().documents('sn97123456')).toBe('<DocumentList/>');
  });
});

describe('HttpClient', () => {
  it('caches cacheable POSTs by body, never mixing different searches', async () => {
    const pool = agent.get(ODP_ORIGIN);
    pool.intercept({ path: '/s', method: 'POST', body: '{"q":"a"}' }).reply(200, { q: 'a' }).times(1);
    pool.intercept({ path: '/s', method: 'POST', body: '{"q":"b"}' }).reply(200, { q: 'b' }).times(1);
    const c = http({ cacheTtlMs: 60_000, cacheMaxItems: 10 });
    expect(await c.call({ method: 'POST', path: '/s', body: { q: 'a' }, cacheable: true })).toEqual({ q: 'a' });
    expect(await c.call({ method: 'POST', path: '/s', body: { q: 'b' }, cacheable: true })).toEqual({ q: 'b' });
    // Served from cache: a third upstream call would find no interceptor and fail.
    expect(await c.call({ method: 'POST', path: '/s', body: { q: 'a' }, cacheable: true })).toEqual({ q: 'a' });
  });

  it('does not cache non-cacheable POSTs', async () => {
    agent.get(ODP_ORIGIN).intercept({ path: '/p', method: 'POST' }).reply(200, { n: 1 }).times(2);
    const c = http({ cacheTtlMs: 60_000, cacheMaxItems: 10 });
    await c.call({ method: 'POST', path: '/p', body: {} });
    await c.call({ method: 'POST', path: '/p', body: {} });
    agent.assertNoPendingInterceptors();
  });

  it('fails oversized responses with ResponseTooLarge instead of buffering them', async () => {
    agent.get(ODP_ORIGIN).intercept({ path: '/big', method: 'GET' }).reply(200, 'x'.repeat(5000));
    await expect(http({ maxResponseBytes: 1000 }).call({ path: '/big', accept: 'text' })).rejects.toMatchObject({ name: 'ResponseTooLarge' });
  });

  it('names auth failures without echoing the request URL or body', async () => {
    agent.get(ODP_ORIGIN).intercept({ path: '/api/v1/patent/applications/search', method: 'POST' }).reply(401, { message: 'Unauthorized' });
    const err = await odp().patents.search('secret query').catch(e => e) as Error;
    expect(err.name).toBe('Unauthorized');
    expect(err.message).toMatch(/API key/);
    expect(err.message).not.toContain('secret query');
  });

  it('surfaces upstream 400 details to the caller', async () => {
    agent.get(ODP_ORIGIN).intercept({ path: '/api/v1/patent/applications/search', method: 'POST' })
      .reply(400, { code: 400, error: 'Bad Request', errorDetails: 'Invalid field: foo' });
    await expect(odp().patents.search('foo:bar')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Invalid field: foo') });
  });

});
