import { describe, it, expect, beforeAll } from 'vitest';
import { buildSupervisor, LIMIT_DEFAULTS } from '../src/supervisor/index.js';
import { execute } from '../src/tools/execute.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';

/**
 * Live acceptance: runs every corpus example against the real USPTO APIs through the real sandbox.
 * Opt-in only (USPTO_LIVE=1 plus keys); never part of PR CI. Read-only, one request at a time,
 * a few dozen calls in total. Run with: USPTO_LIVE=1 pnpm test:live
 */
const LIVE = process.env.USPTO_LIVE === '1';
const ODP_KEY = process.env.USPTO_API_KEY?.trim();
const TSDR_KEY = process.env.USPTO_TSDR_API_KEY?.trim();

describe.skipIf(!LIVE || !ODP_KEY)('live USPTO acceptance', () => {
  let deps: CatalogDeps;
  beforeAll(async () => {
    deps = await buildSupervisor({
      odpBaseUrl: 'https://api.uspto.gov', odpApiKey: ODP_KEY, tsdrBaseUrl: 'https://tsdrapi.uspto.gov', tsdrApiKey: TSDR_KEY,
      userAgent: 'uspto-mcp-server (live acceptance)', upstreamTimeoutMs: 30_000, upstreamRetries: 1,
      cacheTtlMs: 0, cacheMaxItems: 0, sandbox: 'auto',
      limits: { odp: { ...LIMIT_DEFAULTS.odp }, tsdr: { ...LIMIT_DEFAULTS.tsdr } },
    });
  });

  const run = async (code: string) => execute({ code, timeoutMs: 90_000, memoryMb: 128 }, deps);
  const examples = async () => deps.corpus.entries;

  it('every odp endpoint example succeeds against api.uspto.gov', async () => {
    const failures: string[] = [];
    for (const e of (await examples()).values()) {
      if (e.kind !== 'endpoint' || e.binding !== 'odp' || !e.example) continue;
      const code = e.example.includes('return ') ? e.example : `return ${e.example}`;
      const r = await run(code);
      if (!r.ok) failures.push(`${e.id}: ${r.error?.name}: ${r.error?.message?.slice(0, 200)}`);
      else if (r.value === null || (typeof r.value === 'object' && Object.keys(r.value as object).length === 0)) failures.push(`${e.id}: empty result`);
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it('an empty search returns count 0 instead of failing', async () => {
    const r = await run("return await odp.patents.search({ q: 'applicationNumberText:00000000' })");
    expect(r).toMatchObject({ ok: true, value: { count: 0, patentFileWrapperDataBag: [] } });
  });

  it('a missing record keeps NotFound with status 404 inside the sandbox', async () => {
    const r = await run("try { await odp.ptab.proceedings.get('IPR0000-00000'); return 'found'; } catch (e) { return [e.name, e.status]; }");
    expect(r).toMatchObject({ ok: true, value: ['NotFound', 404] });
  });

  it.skipIf(!TSDR_KEY)('every tsdr endpoint example succeeds against tsdrapi.uspto.gov', async () => {
    const failures: string[] = [];
    for (const e of (await examples()).values()) {
      if (e.kind !== 'endpoint' || e.binding !== 'tsdr' || !e.example) continue;
      const code = e.example.includes('return ') ? e.example : `return ${e.example}`;
      const r = await run(code);
      if (!r.ok) failures.push(`${e.id}: ${r.error?.name}: ${r.error?.message?.slice(0, 200)}`);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
