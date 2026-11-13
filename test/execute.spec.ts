import { describe, it, expect } from 'vitest';
import { execute, DEFAULT_CALL_BUDGET } from '../src/tools/execute.js';
import { SubjectQuota } from '../src/util/quotas.js';
import type { SandboxRunner, ExecuteOptions, RpcBridge } from '../src/sandbox/types.js';

// A fake runner that issues `odp` dispatches followed by `tsdr` dispatches, returning the two
// result arrays separately so tests can assert per-binding behavior.
function fakeRunner(odpCalls: number, tsdrCalls = 0, extra: string[] = []): SandboxRunner {
  return {
    kind: 'unavailable',
    available: async () => true,
    async execute(_opts: ExecuteOptions, rpc: RpcBridge) {
      const odp: unknown[] = [];
      const tsdr: unknown[] = [];
      const other: unknown[] = [];
      for (let i = 0; i < odpCalls; i++) odp.push(await rpc.dispatch({ binding: 'odp', path: ['patents', 'search'], args: [{}] }));
      for (let i = 0; i < tsdrCalls; i++) tsdr.push(await rpc.dispatch({ binding: 'tsdr', path: ['status'], args: ['sn97123456'] }));
      for (const b of extra) other.push(await rpc.dispatch({ binding: b, path: ['x'], args: [] }));
      return { ok: true, value: { odp, tsdr, other }, logs: [], durationMs: 0 };
    },
  };
}

const sdk = {
  clients: {} as Record<string, object>,
  methods: {
    odp: { 'patents.search': async () => ({ count: 0 }) },
    tsdr: { status: async () => ({ trademarks: [] }) },
  },
  meta: [
    { name: 'odp', label: 'USPTO Open Data Portal', enabled: true },
    { name: 'tsdr', label: 'USPTO TSDR', enabled: true },
  ],
  registeredNames: ['odp', 'tsdr'],
  version: () => '1.0.0',
};

type R = { ok: boolean; error?: { name: string; message?: string } };
type Out = { value: { odp: R[]; tsdr: R[]; other: R[] } };
const input = { code: '', timeoutMs: 1000, memoryMb: 64 };

describe('per-execute call budgets', () => {
  it('caps each binding independently', async () => {
    const deps = { sdk, sandbox: fakeRunner(5, 4), callBudgets: { odp: 3, tsdr: 1 } };
    const res = await execute(input, deps) as Out;
    expect(res.value.odp.filter(r => r.ok).length).toBe(3);
    expect(res.value.odp.filter(r => r.error?.name === 'CallBudgetExceeded').length).toBe(2);
    expect(res.value.odp.find(r => !r.ok)?.error?.message).toMatch(/USPTO Open Data Portal call budget \(3\)/);
    expect(res.value.tsdr.filter(r => r.ok).length).toBe(1);
    expect(res.value.tsdr.filter(r => r.error?.name === 'CallBudgetExceeded').length).toBe(3);
  });

  it('applies the default budget to a binding without one, and counts unknown bindings', async () => {
    const deps = { sdk, sandbox: fakeRunner(DEFAULT_CALL_BUDGET + 1), callBudgets: {} };
    const res = await execute(input, deps) as Out;
    expect(res.value.odp.filter(r => r.ok).length).toBe(DEFAULT_CALL_BUDGET);
    // An inherited property name is not a budget lookup.
    const proto = await execute(input, { sdk, sandbox: fakeRunner(0, 0, ['__proto__']), callBudgets: {} }) as Out;
    expect(proto.value.other[0]).toMatchObject({ ok: false, error: { name: 'TypeError' } });
  });
});

describe('per-subject quotas', () => {
  it('blocks a subject past its hourly quota, per binding', async () => {
    const deps = { sdk, sandbox: fakeRunner(4, 2), callBudgets: { odp: 100, tsdr: 100 }, subjectQuotas: { odp: new SubjectQuota(2, 3_600_000), tsdr: new SubjectQuota(5, 3_600_000) } };
    const res = await execute(input, deps, { subject: 'tenant-1' }) as Out;
    expect(res.value.odp.filter(r => r.ok).length).toBe(2);
    expect(res.value.odp.filter(r => r.error?.name === 'SubjectQuotaExceeded').length).toBe(2);
    expect(res.value.tsdr.every(r => r.ok)).toBe(true);
  });

  it('does not consult the per-subject quota when there is no subject (stdio)', async () => {
    const deps = { sdk, sandbox: fakeRunner(4), callBudgets: { odp: 100 }, subjectQuotas: { odp: new SubjectQuota(1, 3_600_000) } };
    const res = await execute(input, deps) as Out;
    expect(res.value.odp.every(r => r.ok)).toBe(true);
  });

  it('keeps tenants separate', async () => {
    const quota = new SubjectQuota(1, 3_600_000);
    const deps = { sdk, sandbox: fakeRunner(1), callBudgets: { odp: 100 }, subjectQuotas: { odp: quota } };
    expect(((await execute(input, deps, { subject: 'a' })) as Out).value.odp[0]!.ok).toBe(true);
    expect(((await execute(input, deps, { subject: 'b' })) as Out).value.odp[0]!.ok).toBe(true);
    expect(((await execute(input, deps, { subject: 'a' })) as Out).value.odp[0]!.ok).toBe(false);
  });
});

describe('cancellation before start', () => {
  it('does not start an execution when shutdown or the request is already aborted', async () => {
    let started = false;
    const sandbox = { kind: 'unavailable' as const, available: async () => true, async execute() { started = true; return { ok: true, value: 1, logs: [], durationMs: 0 }; } };
    const shut = new AbortController(); shut.abort();
    expect(await execute(input, { sdk, sandbox, callBudgets: {}, shutdownSignal: shut.signal })).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    const req = new AbortController(); req.abort();
    expect(await execute(input, { sdk, sandbox, callBudgets: {} }, { signal: req.signal })).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(started).toBe(false);
  });
});

describe('sandbox teardown quarantine', () => {
  it('keeps the execution slot until a lingering sandbox process has exited', async () => {
    const { ExecutionLimiter } = await import('../src/util/executionLimiter.js');
    const { TEARDOWN } = await import('../src/sandbox/types.js');
    let exited!: () => void;
    const gone = new Promise<void>(r => { exited = r; });
    const lingering = { kind: 'unavailable' as const, available: async () => true,
      async execute() { return Object.defineProperty({ ok: true, value: 1, logs: [], durationMs: 0 }, TEARDOWN, { value: gone }); } };
    const limiter = new ExecutionLimiter(1, 1);
    expect(await execute(input, { sdk, sandbox: lingering, callBudgets: {}, executionLimiter: limiter })).toMatchObject({ ok: true });
    expect(limiter.tryAcquire()).toMatchObject({ error: expect.any(String) }); // still quarantined
    exited();
    await new Promise(r => setTimeout(r, 0));
    expect('release' in limiter.tryAcquire()).toBe(true);
  });
});
