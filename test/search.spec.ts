import { describe, it, expect } from 'vitest';
import { Bm25Index, tokenize } from '../src/search/bm25.js';
import { buildCorpus } from '../src/search/corpus.js';
import { getSources } from '../src/sdk/sources/index.js';
import { searchApi } from '../src/tools/searchApi.js';
import { describeSchema } from '../src/tools/describeSchema.js';
import { sourceCfg } from './helpers.js';

function corpus() {
  return buildCorpus(getSources(sourceCfg()));
}

describe('bm25', () => {
  it('tokenizes', () => {
    expect(tokenize('Hello, world! THE quick brown fox.')).toEqual(['hello', 'world', 'quick', 'brown', 'fox']);
  });

  it('scores relevant docs higher', () => {
    const idx = new Bm25Index();
    idx.add({ id: 'a', text: 'methane emissions rule from the EPA' });
    idx.add({ id: 'b', text: 'aviation safety notice' });
    idx.add({ id: 'c', text: 'methane reporting requirements' });
    const hits = idx.search('methane', 5);
    expect(hits[0]).toBeDefined();
    expect(['a', 'c']).toContain(hits[0]!.id);
  });
});

describe('corpus', () => {
  it('loads endpoints and fields from sources', () => {
    const { entries } = corpus();
    expect(entries.has('odp.patents.search')).toBe(true);
    expect(entries.has('tsdr.status')).toBe(true);
    expect(entries.has('odp.fields.patents.applicationMetaData')).toBe(true);
  });
});

describe('search_api tool', () => {
  // Natural-language questions an assistant is likely to ask, and a method that answers each.
  const cases: Array<[string, string]> = [
    ['search patent applications by invention title and filing date', 'odp.patents.search'],
    ['inter partes review IPR trial proceedings for a patent', 'odp.ptab.proceedings.search'],
    ['final written decision PTAB trial outcome', 'odp.ptab.decisions.search'],
    ['ex parte appeal decision examiner affirmed reversed', 'odp.ptab.appeals.search'],
    ['trademark status by serial number', 'tsdr.status'],
    ['patent term adjustment days', 'odp.patents.adjustment'],
    ['who owns this patent assignment reel frame assignee', 'odp.patents.assignment'],
    ['petition to revive abandoned application decision', 'odp.petitions.search'],
    ['office action full text rejection 35 U.S.C. 103', 'odp.officeActions.search'],
    ['find application for granted patent number', 'odp.patents.byPatentNumber'],
    ['parent continuation divisional applications', 'odp.patents.continuity'],
    ['bulk dataset download files grant full text XML', 'odp.bulk.get'],
  ];
  it('finds the right method in the top 5 for typical questions', () => {
    const c = corpus();
    const misses = cases.filter(([query, id]) => !searchApi({ query, k: 5 }, c).hits.some(h => h.id === id));
    expect(misses).toEqual([]);
  });
});

describe('describe_schema tool', () => {
  it('resolves an exact path', () => {
    const r = describeSchema({ path: 'odp.patents.search' }, corpus().entries);
    expect(r.found).toBe(true);
    if (r.found) expect(r.entries[0]?.binding).toBe('odp');
  });
  it('lists by prefix', () => {
    const r = describeSchema({ prefix: 'odp.ptab.' }, corpus().entries);
    expect(r.found).toBe(true);
    if (r.found) expect(r.entries.filter(e => e.kind === 'endpoint').length).toBe(14);
  });
  it('returns not-found cleanly', () => {
    const r = describeSchema({ path: 'odp.nope' }, corpus().entries);
    expect(r.found).toBe(false);
  });
});
