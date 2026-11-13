import { describe, it, expect } from 'vitest';
import { getSources, validateSourceNames } from '../src/sdk/sources/index.js';
import { sourceCfg } from './helpers.js';

describe('source registry', () => {
  it('builds odp and tsdr with corpora', () => {
    const sources = getSources(sourceCfg());
    expect(sources.map(s => s.name)).toEqual(['odp', 'tsdr']);
    for (const s of sources) expect(s.corpus.endpoints.length).toBeGreaterThan(0);
    expect(sources[0]!.label).toBe('USPTO Open Data Portal');
  });

  it('every registered method has a corpus endpoint entry, and every endpoint entry a method', () => {
    for (const s of getSources(sourceCfg())) {
      const methods = Object.keys(s.methods).map(m => `${s.name}.${m}`).sort();
      const endpoints = s.corpus.endpoints.map(e => e.id).sort();
      expect(endpoints).toEqual(methods);
      for (const e of s.corpus.endpoints) {
        expect(e.binding).toBe(s.name);
        expect(e.signature?.startsWith(e.id)).toBe(true);
      }
    }
  });
});

describe('validateSourceNames', () => {
  it('throws for an invalid identifier', () => {
    expect(() => validateSourceNames([{ name: 'odp.patents' }])).toThrow(/must be a JS identifier/);
    expect(() => validateSourceNames([{ name: '9bad' }])).toThrow(/must be a JS identifier/);
  });

  it('throws for a denylisted name', () => {
    expect(() => validateSourceNames([{ name: 'console' }])).toThrow(/not allowed/);
    expect(() => validateSourceNames([{ name: 'process' }])).toThrow(/not allowed/);
  });

  it('throws for a duplicate name', () => {
    expect(() => validateSourceNames([{ name: 'odp' }, { name: 'odp' }])).toThrow(/Duplicate/);
  });

  it('does not throw for valid distinct first-party names', () => {
    expect(() => validateSourceNames([{ name: 'odp' }, { name: 'tsdr' }])).not.toThrow();
  });
});

describe('keyed sources enable/disable', () => {
  it('are disabled without API keys, with actionable reasons', () => {
    const [odp, tsdr] = getSources(sourceCfg());
    expect(odp!.enabled).toBe(false);
    expect(odp!.disabledReason).toMatch(/USPTO_API_KEY/);
    expect(odp!.disabledReason).toMatch(/data\.uspto\.gov/);
    expect(tsdr!.enabled).toBe(false);
    expect(tsdr!.disabledReason).toMatch(/USPTO_TSDR_API_KEY/);
  });

  it('are enabled when keys are provided, and never leak them', () => {
    const sources = getSources(sourceCfg({ odpKey: 'SECRET-ODP-KEY-0123456789', tsdrKey: 'SECRET-TSDR-KEY-0123456789' }));
    for (const s of sources) {
      expect(s.enabled).toBe(true);
      const json = JSON.stringify({ ...s, corpus: undefined });
      expect(json).not.toContain('SECRET-ODP-KEY');
      expect(json).not.toContain('SECRET-TSDR-KEY');
      expect(json).not.toMatch(/X-API-KEY|USPTO-API-KEY/i);
    }
  });
});
