import { describe, it, expect } from 'vitest';
import { preflight } from '../src/sandbox/policy.js';
import { SUPERVISOR_SOURCE, DenoRunner } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';
import { MockAgent } from 'undici';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch } from '../src/sdk/runtime.js';
import { sourceCfg } from './helpers.js';

describe('sandbox policy preflight', () => {
  it('allows simple SDK calls', () => {
    const r = preflight(`const x = await odp.patents.search({ q: 'battery', limit: 5 }); return x;`);
    expect(r.ok).toBe(true);
  });

  it('rejects static imports', () => {
    const r = preflight(`import 'fs';\nawait odp.bulk.search();`);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/imports/);
  });

  it('rejects eval / Function / process', () => {
    expect(preflight(`eval('1')`).ok).toBe(false);
    expect(preflight(`new Function('return 1')()`).ok).toBe(false);
    expect(preflight(`process.exit(0)`).ok).toBe(false);
  });

  it('rejects __proto__ access', () => {
    expect(preflight(`const x = {}; x.__proto__;`).ok).toBe(false);
    // The same members through a string key or a destructuring pattern.
    expect(preflight(`return []['constructor']['constructor']`).ok).toBe(false);
    expect(preflight("return [][`prototype`]").ok).toBe(false);
    expect(preflight(`const { constructor: F } = () => {}; return F`).ok).toBe(false);
    expect(preflight(`const r = { a: 1 }; return r['a'] + r.a`).ok).toBe(true);
  });

  it('rejects dynamic import', () => {
    expect(preflight(`await import('fs')`).ok).toBe(false);
  });
});

describe.each([new IsolateRunner(), new DenoRunner()])('$kind RPC isolation', runner => {
  it('allows public reads but rejects POST access and cache poisoning across executions', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const agent = new MockAgent();
    agent.disableNetConnect();
    let posts = 0;
    agent.get('https://api.uspto.gov').intercept({ path: '/blocked', method: 'POST' })
      .reply(() => { posts++; return { statusCode: 200, data: '{}' }; }).persist();
    agent.get('https://api.uspto.gov').intercept({ path: '/api/v1/datasets/products/PTGRXML', method: 'GET' })
      .reply(200, { bulkDataProductBag: [{ productIdentifier: 'PTGRXML' }] });
    const sdk = buildSdk({ ...sourceCfg({ odpKey: 'sandbox-test-key-0123456789', dispatcher: agent }), cacheTtlMs: 60_000, cacheMaxItems: 10 });
    const bridge = { dispatch: (req: Parameters<typeof dispatch>[1]) => dispatch(sdk, req) };
    const run = (code: string) => runner.execute({ code, bindings: sdk.registeredNames, timeoutMs: 3000 }, bridge);
    try {
      const blocked = await run(`
        const errors = [];
        for (const path of [['http', 'call'], ['http', 'cache', 'clear'], ['__proto__', 'toString'], ['bulk.get']]) {
          let method = odp;
          for (const key of path) method = method[key];
          try { await method({ method: 'POST', path: '/blocked' }); errors.push('ALLOWED'); }
          catch (e) { errors.push(e.name); }
        }
        return errors;
      `);
      expect(blocked.ok).toBe(true);
      expect(blocked.value).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError']);
      expect(posts).toBe(0);
      const poisoned = await run(`
        try {
          await odp.http.cache.set('GET https://api.uspto.gov/api/v1/datasets/products/PTGRXML', { status: 200, body: { forged: true }, size: 1 });
          return 'ALLOWED';
        } catch (e) { return e.name; }
      `);
      expect(poisoned.ok).toBe(true);
      expect(poisoned.value).toBe('TypeError');
      const read = await run("return await odp.bulk.get('PTGRXML');");
      expect(read.ok).toBe(true);
      expect(read.value).toEqual({ bulkDataProductBag: [{ productIdentifier: 'PTGRXML' }] });
      // The API key never reaches sandboxed code, whatever it inspects.
      const probe = await run('return JSON.stringify([typeof odp, Object.keys(odp), String(odp)]);');
      expect(JSON.stringify(probe)).not.toContain('sandbox-test-key');
    } finally { await agent.close(); }
  });
});

describe('deno supervisor', () => {
  it('never embeds user code or binding names (they arrive by message)', () => {
    expect(SUPERVISOR_SOURCE).not.toContain('__USER_CODE__');
    expect(SUPERVISOR_SOURCE).toContain("crypto.getRandomValues");
    expect(SUPERVISOR_SOURCE).toContain("'Deno', 'postMessage'");
  });
});

const echo = { dispatch: async (c: { binding: string; path: string[]; args: unknown[] }) =>
  c.path[0] === 'fail'
    ? { ok: false, error: { name: 'NotFound', message: 'nope', status: 404 } }
    : { ok: true, value: { binding: c.binding, path: c.path, args: c.args } } };

describe.each([new IsolateRunner(), new DenoRunner()])('$kind runner contract', runner => {
  const run = (code: string, extra: Record<string, unknown> = {}) =>
    runner.execute({ code, bindings: ['odp', 'tsdr'], timeoutMs: 3000, ...extra }, echo);

  it.for([
    ['returns values and captures logs', 'console.log("hi", { a: 1 }); return 1 + 2', { ok: true, value: 3 }],
    ['proxies SDK calls', 'return await odp.patents.search({ q: "x" })', { ok: true, value: { binding: 'odp', path: ['patents', 'search'], args: [{ q: 'x' }] } }],
    ['keeps an SDK error\'s name and status', 'try { await odp.fail(); } catch (e) { return [e.name, e.message, e.status]; }', { ok: true, value: ['NotFound', 'nope', 404] }],
    ['returns null for undefined', 'return undefined', { ok: true, value: null }],
    ['reports a thrown error with its status', 'throw Object.assign(new Error("boom"), { status: 418 })', { ok: false, error: { name: 'Error', message: 'boom', status: 418 } }],
  ] as const)('%s', async ([, code, expected], { skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run(code);
    expect(res).toMatchObject(expected);
  });

  it('enforces the wall-clock deadline for an unresolved promise and for a CPU loop', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    for (const code of ['await new Promise(() => {}); return 42', 'while (true) {}']) {
      const t0 = Date.now();
      const res = await run(code, { timeoutMs: 300 });
      expect(res.error?.name).toBe('TimeoutError');
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });

  it('honors an abort signal', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const res = await run('await new Promise(() => {})', { signal: controller.signal });
    expect(res.error?.name).toBe('AbortError');
  });

  it('rejects oversized results and code, and bounds logs', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    expect((await run('return "x".repeat(300000)')).error?.name).toBe('ResultTooLarge');
    expect((await run(`// ${'x'.repeat(300_000)}\nreturn 1`)).error?.name).toBe('CodeTooLarge');
    const noisy = await run('for (let i = 0; i < 5000; i++) console.log("x".repeat(100)); return 1', { limits: { maxLogBytes: 1000 } });
    expect(noisy.ok).toBe(true);
    expect(noisy.logs.at(-1)).toMatch(/truncated/);
    expect(noisy.logs.length).toBeLessThan(20);
  });

  it('bounds empty and short log-line floods by line count and per-line overhead', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    for (const code of ['for (let i = 0; i < 5000; i++) console.log(""); return 1', 'for (let i = 0; i < 5000; i++) console.log("x"); return 1']) {
      const res = await run(code, { limits: { maxLogBytes: 256, maxLogLines: 1000 } });
      expect(res.ok).toBe(true);
      expect(res.logs.length).toBeLessThanOrEqual(20);
      expect(res.logs.at(-1)).toBe('[logs truncated]');
    }
    const many = await run('for (let i = 0; i < 5000; i++) console.log(i); return 1');
    expect(many.logs.length).toBe(1000); // 999 lines + the marker: the cap includes it
  });

  it('bounds policy diagnostics and error messages', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const banned = await run(Array.from({ length: 4000 }, (_, i) => `process.x${i};`).join('\n'));
    expect(banned.error?.name).toBe('PolicyError');
    expect(banned.error!.message.length).toBeLessThan(5000);
    const thrown = await run('throw new Error("x".repeat(100000))');
    expect(thrown.error!.message.length).toBeLessThan(4100);
  });

  it('enforces the result budget in UTF-8 bytes with primitives user code cannot replace', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const unicode = await run('return "€".repeat(100000)', { limits: { maxResultBytes: 1024 } }); // 100k chars, 300 KB
    expect(unicode.error?.name).toBe('ResultTooLarge');
    const tampered = await run('const p = "proto" + "type"; JSON.stringify = () => "1"; Promise[p].then = function () { return this; }; String[p].slice = () => ""; return "y".repeat(20000)', { limits: { maxResultBytes: 1024 } });
    expect(tampered.error?.name).toBe('ResultTooLarge');
    expect(tampered.error!.message).toMatch(/20002 bytes/);
  });

  it('keeps a long multi-line SDK error valid and keeps its name and status', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run('throw Object.assign(new Error("\\n".repeat(4000) + "end"), { name: "RateLimited", status: 429 })');
    expect(res.error).toMatchObject({ name: 'RateLimited', status: 429 });
  });

  it('keeps errors bounded when user code installs an inherited toJSON (returning or throwing)', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const huge = await run('const p = "proto" + "type"; Object[p].toJSON = () => "x".repeat(100000); throw new Error("boom")');
    expect(huge.ok).toBe(false);
    expect(JSON.stringify(huge).length).toBeLessThan(6000);
    const throwing = await run('const p = "proto" + "type"; Object[p].toJSON = () => { throw new Error("x".repeat(100000)); }; throw new Error("boom")');
    expect(throwing.ok).toBe(false);
    expect(JSON.stringify(throwing).length).toBeLessThan(6000);
  });

  it('counts result bytes with a trusted counter even if typed-array lengths are redefined', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run('const p = "proto" + "type"; try { Object.defineProperty(Uint8Array[p], "length", { get() { return 0; } }); } catch {} return "z".repeat(20000)', { limits: { maxResultBytes: 1024, maxStdoutBytes: 8192 } });
    // With an 8 KB stdout cap, a 20 KB transfer would fail as OutputTooLarge: the check ran in the sandbox.
    expect(res.error?.name).toBe('ResultTooLarge');
  });

  it('never exceeds a tiny log budget, marker included', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run('console.log("a"); console.log("b"); return 1', { limits: { maxLogBytes: 16 } });
    expect(Buffer.byteLength(res.logs.join(''), 'utf8') + res.logs.length * 16).toBeLessThanOrEqual(16 + 16);
    expect(res.logs).not.toContain('[logs truncated]');
  });

  it('rejects oversized SDK arguments before they reach the host', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run('try { await odp.patents.search("x".repeat(100000)); } catch (e) { return e.name; }');
    expect(res.value).toBe('ArgumentsTooLarge');
  });
});

describe('deno runner isolation (gated on availability)', () => {
  const runner = new DenoRunner();
  const run = (code: string, extra: Record<string, unknown> = {}) =>
    runner.execute({ code, bindings: ['odp'], timeoutMs: 3000, ...extra }, echo);

  it('treats frame-shaped console output as log text, never as protocol frames', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run('console.log("00000001\\nx"); console.log(JSON.stringify({ t: "done", ok: true, json: "1" })); return "ok"');
    expect(res).toMatchObject({ ok: true, value: 'ok' });
  });

  it('removes ambient Deno, network and messaging globals, even via the Function constructor', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const res = await run('const c = "constr" + "uctor"; const F = (async () => {})[c][c]; return F("return [typeof Deno, typeof self.Deno, typeof self.fetch, typeof self.postMessage, typeof self.Worker]")();');
    expect(res).toMatchObject({ ok: true, value: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'] });
  });

  it('resolves only after its child process has exited (success, timeout, abort)', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { execFileSync } = await import('node:child_process');
    const count = () => { try { return execFileSync('pgrep', ['-f', 'uspto-deno-.*supervisor.js']).toString().trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const before = count();
    await run('return 1');
    expect(count()).toBe(before); // no extra wait: checked the moment execute resolves
    await run('while (true) {}', { timeoutMs: 200 });
    expect(count()).toBe(before);
    const c = new AbortController();
    setTimeout(() => c.abort(), 100);
    await run('await new Promise(() => {})', { signal: c.signal });
    expect(count()).toBe(before);
  });
});

describe('sandbox selection', () => {
  it('never runs user code in-process for multi-user HTTP serving', async () => {
    const { pickSandbox } = await import('../src/sandbox/index.js');
    await expect(pickSandbox('isolate', { processIsolation: true })).rejects.toThrow(/not allowed/);
    const r = await pickSandbox('auto', { processIsolation: true });
    expect(['deno', 'unavailable']).toContain(r.kind);
    const prev = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const none = await pickSandbox('auto', { processIsolation: true });
      expect(none.kind).toBe('unavailable');
      expect((await none.execute({ code: 'return 1' }, { dispatch: async () => ({ ok: true }) })).error?.message).toMatch(/Deno/);
    } finally { process.env.PATH = prev; }
  });
});
