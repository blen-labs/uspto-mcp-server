import { describe, it, expect } from 'vitest';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch } from '../src/sdk/runtime.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';
import { sourceCfg } from './helpers.js';

describe('buildSdk + dispatch', () => {
  it('registers every source, but exposes clients only for keyed (enabled) ones', () => {
    const sdk = buildSdk(sourceCfg({ odpKey: 'k'.repeat(30) }));
    expect(sdk.registeredNames).toEqual(['odp', 'tsdr']);
    expect(Object.keys(sdk.clients)).toEqual(['odp']);
    expect(sdk.meta.find(m => m.name === 'odp')?.enabled).toBe(true);
    expect(sdk.meta.find(m => m.name === 'tsdr')?.enabled).toBe(false);
  });

  it('dispatch returns TypeError for an unknown binding', async () => {
    const sdk = buildSdk(sourceCfg());
    const res = await dispatch(sdk, { binding: 'nope', path: ['x'], args: [] });
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('TypeError');
  });
});

describe('disabled source degradation', () => {
  it('dispatch returns SourceUnavailable for a registered-but-disabled binding', async () => {
    const sdk = buildSdk(sourceCfg()); // no keys -> both disabled
    expect(sdk.registeredNames).toContain('odp');
    expect(sdk.clients.odp).toBeUndefined();
    const res = await dispatch(sdk, { binding: 'odp', path: ['patents', 'search'], args: [{}] });
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('SourceUnavailable');
    expect(res.error?.message).toMatch(/USPTO_API_KEY/);
    const tsdr = await dispatch(sdk, { binding: 'tsdr', path: ['status'], args: ['sn97123456'] });
    expect(tsdr.error?.message).toMatch(/USPTO_TSDR_API_KEY/);
  });

  it('globals are defined in the sandbox even when disabled (no ReferenceError)', async ({ skip }) => {
    const runner = new IsolateRunner();
    if (!(await runner.available())) return skip();
    const sdk = buildSdk(sourceCfg());
    const bridge = { dispatch: (req: { binding: string; path: string[]; args: unknown[] }) => dispatch(sdk, req) };
    const res = await runner.execute({ code: 'try { await odp.patents.search("x"); return "no-throw"; } catch (e) { return e.name; }', bindings: sdk.registeredNames }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('SourceUnavailable');
  });
});
