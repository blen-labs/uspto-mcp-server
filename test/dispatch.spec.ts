import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { buildSdk } from '../src/sdk/bindings.js';
import { getSources } from '../src/sdk/sources/index.js';
import { dispatch, type RpcRequest } from '../src/sdk/runtime.js';
import { sourceCfg, ODP_ORIGIN, TSDR_ORIGIN } from './helpers.js';

const ODP_KEY = 'test-only-odp-key-0123456789';
const TSDR_KEY = 'test-only-tsdr-key-0123456789';
const config = { ...sourceCfg({ odpKey: ODP_KEY, tsdrKey: TSDR_KEY }), cacheTtlMs: 60_000, cacheMaxItems: 10 };

const P = '/api/v1/patent/applications';
// Exercise every supported SDK method through dispatch, not just the HTTP clients.
const reads: Array<[string, unknown[], 'GET' | 'POST', string]> = [
  ['odp.patents.search', ['battery'], 'POST', `${P}/search`],
  ['odp.patents.get', ['17248024'], 'GET', `${P}/17248024`],
  ['odp.patents.byPatentNumber', ['11000000'], 'POST', `${P}/search`],
  ['odp.patents.metaData', ['17248024'], 'GET', `${P}/17248024/meta-data`],
  ['odp.patents.adjustment', ['17248024'], 'GET', `${P}/17248024/adjustment`],
  ['odp.patents.assignment', ['17248024'], 'GET', `${P}/17248024/assignment`],
  ['odp.patents.attorney', ['17248024'], 'GET', `${P}/17248024/attorney`],
  ['odp.patents.continuity', ['17248024'], 'GET', `${P}/17248024/continuity`],
  ['odp.patents.foreignPriority', ['17248024'], 'GET', `${P}/17248024/foreign-priority`],
  ['odp.patents.transactions', ['17248024'], 'GET', `${P}/17248024/transactions`],
  ['odp.patents.documents', ['17248024'], 'GET', `${P}/17248024/documents`],
  ['odp.patents.associatedDocuments', ['17248024'], 'GET', `${P}/17248024/associated-documents`],
  ['odp.patents.statusCodes', [], 'POST', '/api/v1/patent/status-codes'],
  ['odp.ptab.proceedings.search', [], 'POST', '/api/v1/patent/trials/proceedings/search'],
  ['odp.ptab.proceedings.get', ['IPR2021-01599'], 'GET', '/api/v1/patent/trials/proceedings/IPR2021-01599'],
  ['odp.ptab.decisions.search', [], 'POST', '/api/v1/patent/trials/decisions/search'],
  ['odp.ptab.decisions.get', ['171339223'], 'GET', '/api/v1/patent/trials/decisions/171339223'],
  ['odp.ptab.decisions.byTrial', ['IPR2021-01599'], 'GET', '/api/v1/patent/trials/IPR2021-01599/decisions'],
  ['odp.ptab.documents.search', [], 'POST', '/api/v1/patent/trials/documents/search'],
  ['odp.ptab.documents.get', ['171339223'], 'GET', '/api/v1/patent/trials/documents/171339223'],
  ['odp.ptab.documents.byTrial', ['IPR2021-01599'], 'GET', '/api/v1/patent/trials/IPR2021-01599/documents'],
  ['odp.ptab.appeals.search', [], 'POST', '/api/v1/patent/appeals/decisions/search'],
  ['odp.ptab.appeals.get', ['d1'], 'GET', '/api/v1/patent/appeals/decisions/d1'],
  ['odp.ptab.appeals.byAppeal', ['2023001234'], 'GET', '/api/v1/patent/appeals/2023001234/decisions'],
  ['odp.ptab.interferences.search', [], 'POST', '/api/v1/patent/interferences/decisions/search'],
  ['odp.ptab.interferences.get', ['d1'], 'GET', '/api/v1/patent/interferences/decisions/d1'],
  ['odp.ptab.interferences.byInterference', ['105970'], 'GET', '/api/v1/patent/interferences/105970/decisions'],
  ['odp.petitions.search', [], 'POST', '/api/v1/petition/decisions/search'],
  ['odp.petitions.get', ['p1'], 'GET', '/api/v1/petition/decisions/p1'],
  ['odp.officeActions.search', [], 'POST', '/api/v1/patent/office-action/search'],
  ['odp.officeActions.get', ['r1'], 'GET', '/api/v1/patent/office-action/r1'],
  ['odp.officeActions.text', ['r1'], 'GET', '/api/v1/patent/office-action/r1/download/officeActionText'],
  ['odp.oa.text.search', [], 'POST', '/api/v1/patent/oa/oa_actions/v1/records'],
  ['odp.oa.text.fields', [], 'GET', '/api/v1/patent/oa/oa_actions/v1/fields'],
  ['odp.oa.citations.search', [], 'POST', '/api/v1/patent/oa/oa_citations/v2/records'],
  ['odp.oa.citations.fields', [], 'GET', '/api/v1/patent/oa/oa_citations/v2/fields'],
  ['odp.oa.rejections.search', [], 'POST', '/api/v1/patent/oa/oa_rejections/v2/records'],
  ['odp.oa.rejections.fields', [], 'GET', '/api/v1/patent/oa/oa_rejections/v2/fields'],
  ['odp.oa.enrichedCitations.search', [], 'POST', '/api/v1/patent/oa/enriched_cited_reference_metadata/v3/records'],
  ['odp.oa.enrichedCitations.fields', [], 'GET', '/api/v1/patent/oa/enriched_cited_reference_metadata/v3/fields'],
  ['odp.bulk.search', [], 'GET', '/api/v1/datasets/products/search'],
  ['odp.bulk.get', ['PTGRXML'], 'GET', '/api/v1/datasets/products/PTGRXML'],
  ['tsdr.status', ['sn97123456'], 'GET', '/ts/cd/casestatus/sn97123456/info'],
  ['tsdr.multiStatus', ['sn', ['97123456']], 'GET', '/ts/cd/caseMultiStatus/sn?ids=97123456'],
  ['tsdr.documents', ['sn97123456'], 'GET', '/ts/cd/casedocs/sn97123456/info'],
  ['tsdr.documentInfo', ['sn97123456', 'NFIN20240115'], 'GET', '/ts/cd/casedoc/sn97123456/NFIN20240115/info'],
  ['tsdr.lastUpdate', ['97123456'], 'GET', '/last-update/info.json?sn=97123456'],
];

describe('RPC method boundary', () => {
  it('every SDK method reaches its USPTO endpoint with the right method, path and key header', async () => {
    const failures: string[] = [];
    for (const [id, args, method, path] of reads) {
      const agent = new MockAgent();
      agent.disableNetConnect();
      try {
        const [binding, ...methodPath] = id.split('.') as [string, ...string[]];
        const value = { endpoint: id };
        const origin = binding === 'odp' ? ODP_ORIGIN : TSDR_ORIGIN;
        const headers: Record<string, string> = binding === 'odp' ? { 'x-api-key': ODP_KEY } : { 'uspto-api-key': TSDR_KEY };
        agent.get(origin).intercept({ path: p => p.split('?')[0] === path.split('?')[0] && (!path.includes('?') || p === path), method, headers })
          .reply(200, value, { headers: { 'content-type': 'application/json' } });
        const res = await dispatch(buildSdk({ ...config, dispatcher: agent }), { binding, path: methodPath, args });
        if (JSON.stringify(res) !== JSON.stringify({ ok: true, value })) failures.push(`${id}: ${JSON.stringify(res).slice(0, 200)}`);
      } finally { await agent.close(); }
    }
    expect(failures).toEqual([]);
  });

  it.each(['odp', 'tsdr'])('rejects internal and inherited methods for %s before upstream access', async binding => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    try {
      const sdk = buildSdk({ ...config, dispatcher: agent });
      for (const path of [
        ['http', 'call'], ['http', 'cache', 'clear'], ['http', 'cache', 'set'],
        ['http', 'cacheKey'], ['http', 'preflightLimiter', 'tryTake'], ['search'], ['dsapi'], ['app'],
        ['constructor'], ['toString'], ['__proto__', 'toString'],
        ['patents', 'toString'], ['patents', '__proto__', 'toString'],
        ['patents', 'search', 'call'], ['patents.search'], [], ['missing'],
      ]) {
        const result = await dispatch(sdk, { binding, path, args: [{ method: 'POST', path: '/blocked' }] });
        expect(result.ok, path.join('.')).toBe(false);
        expect(result.error?.name, path.join('.')).toBe('TypeError');
      }
    } finally { await agent.close(); }
  });

  it.each(['__proto__', 'constructor', 'toString'])('rejects inherited binding %s', async binding => {
    const sdk = buildSdk(config);
    expect((await dispatch(sdk, { binding, path: ['toString'], args: [] })).error?.name).toBe('TypeError');
  });

  it('rejects malformed bridge messages without invoking a method', async () => {
    const sdk = buildSdk(config);
    for (const req of [
      null, {}, { binding: null, path: ['search'], args: [] },
      { binding: 'odp', path: 'patents.search', args: [] },
      { binding: 'odp', path: ['patents', null], args: [] },
      { binding: 'odp', path: ['patents', 'search'], args: {} },
    ]) {
      expect(await dispatch(sdk, req as unknown as RpcRequest)).toMatchObject({ ok: false, error: { name: 'TypeError' } });
    }
  });

  it('does not call inherited or accessor entries in method registries', async () => {
    const trap = () => { throw new Error('Registry traversal invoked a getter or inherited method'); };
    const methods = Object.create({ inherited: trap });
    Object.defineProperty(methods, 'accessor', { get: trap });
    const registry = { methods: { test: methods }, meta: [] };
    for (const path of [['inherited'], ['accessor']]) {
      expect(await dispatch(registry, { binding: 'test', path, args: [] }))
        .toMatchObject({ ok: false, error: { name: 'TypeError' } });
    }
  });

  it('turns argument validation errors into TypeError results, not host crashes', async () => {
    const sdk = buildSdk(config);
    expect(await dispatch(sdk, { binding: 'odp', path: ['patents', 'get'], args: ['../../x'] }))
      .toMatchObject({ ok: false, error: { name: 'TypeError' } });
  });
});

describe('method registry and dispatch table stay in sync', () => {
  it('dispatch test table covers every registered method', () => {
    const registered = getSources(config).flatMap(s => Object.keys(s.methods).map(m => `${s.name}.${m}`)).sort();
    expect(reads.map(([id]) => id).sort()).toEqual(registered);
  });
});
