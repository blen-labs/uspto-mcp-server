import { z } from 'zod';
import type { Sdk } from '../sdk/bindings.js';
import { dispatch } from '../sdk/runtime.js';
import { TEARDOWN, type SandboxRunner, type WithTeardown } from '../sandbox/types.js';
import { SubjectQuota } from '../util/quotas.js';
import { ExecutionLimiter } from '../util/executionLimiter.js';
import { runWithSignal } from '../util/executionContext.js';
import { DEFAULT_LIMITS } from '../sandbox/limits.js';

export const ExecuteInput = z.object({
  code: z.string().min(1).max(DEFAULT_LIMITS.maxCodeBytes).describe('JavaScript to run inside the sandbox (plain JS: TypeScript type annotations are rejected; top-level await/return are allowed). SDK globals: `odp` (USPTO Open Data Portal: patents, PTAB, petitions, office actions, bulk datasets) and `tsdr` (trademark status).'),
  // USPTO serves one request at a time per API key, so multi-call scripts need more time than
  // a parallel API would.
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  memoryMb: z.number().int().min(16).max(256).default(64),
});

export type ExecuteInputT = z.infer<typeof ExecuteInput>;

export interface ExecuteDeps {
  sdk: Sdk;
  sdkForSubject?: (subject?: string) => Promise<Sdk>;
  sandbox: SandboxRunner;
  /** Upstream calls one execute may make, per binding. A binding without an entry gets DEFAULT_CALL_BUDGET. */
  callBudgets: Readonly<Record<string, number>>;
  /** Per-subject hourly quotas by binding. Absent in account mode, which limits per account in PostgreSQL. */
  subjectQuotas?: Readonly<Record<string, SubjectQuota>>;
  /** Caps simultaneous executions; omitted means unlimited (tests). */
  executionLimiter?: ExecutionLimiter;
  /** Aborts every execution, e.g. on shutdown. */
  shutdownSignal?: AbortSignal;
}

export const DEFAULT_CALL_BUDGET = 25;

/**
 * Per-request context, re-derived from the caller's bearer token on every HTTP request.
 * stdio has no subject.
 */
export interface RequestCtx {
  subject?: string;
  /** The MCP request's abort signal: the client cancelled or disconnected. */
  signal?: AbortSignal;
}

export async function execute(input: ExecuteInputT, deps: ExecuteDeps, requestCtx?: RequestCtx) {
  const upstream = [deps.shutdownSignal, requestCtx?.signal].filter((s): s is AbortSignal => Boolean(s));
  if (upstream.some(s => s.aborted)) {
    return { ok: false, logs: [], error: { name: 'AbortError', message: deps.shutdownSignal?.aborted ? 'The server is shutting down.' : 'The request was cancelled.' }, durationMs: 0 };
  }
  const admitted = deps.executionLimiter?.tryAcquire(requestCtx?.subject);
  if (admitted && 'error' in admitted) {
    return { ok: false, logs: [], error: { name: 'Busy', message: admitted.error }, durationMs: 0 };
  }
  // Aborted when this execution ends for any reason, or when the client cancels / disconnects or
  // the server shuts down, so the sandbox and queued and in-flight upstream calls stop.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of upstream) s.addEventListener('abort', onAbort, { once: true });
  let teardown: Promise<void> | undefined;
  try {
    const result = await runExecution(input, deps, requestCtx, controller.signal);
    teardown = (result as WithTeardown<typeof result>)[TEARDOWN];
    return result;
  } finally {
    controller.abort();
    for (const s of upstream) s.removeEventListener('abort', onAbort);
    // A sandbox process that has not exited yet keeps its execution slot until it does.
    if (teardown) void teardown.then(() => admitted?.release());
    else admitted?.release();
  }
}

async function runExecution(input: ExecuteInputT, deps: ExecuteDeps, requestCtx: RequestCtx | undefined, signal: AbortSignal) {
  const sdk = deps.sdkForSubject ? await deps.sdkForSubject(requestCtx?.subject) : deps.sdk;
  const calls = new Map<string, number>();
  const labelOf = (binding: string) => sdk.meta.find(m => m.name === binding)?.label ?? binding;
  return deps.sandbox.execute(
    { code: input.code, timeoutMs: input.timeoutMs, memoryMb: input.memoryMb, bindings: sdk.registeredNames, signal },
    {
      dispatch: (req, ctx) => {
        const binding = typeof req?.binding === 'string' ? req.binding : '';
        const budget = Object.hasOwn(deps.callBudgets, binding) ? deps.callBudgets[binding]! : DEFAULT_CALL_BUDGET;
        const used = calls.get(binding) ?? 0;
        if (used >= budget) {
          return Promise.resolve({ ok: false, error: { name: 'CallBudgetExceeded', message: `Exceeded the per-execute ${labelOf(binding)} call budget (${budget}). Narrow the search (filters, fields, larger page size) or split the work across separate execute calls.` } });
        }
        const quota = requestCtx?.subject && deps.subjectQuotas && Object.hasOwn(deps.subjectQuotas, binding) ? deps.subjectQuotas[binding] : undefined;
        if (quota) {
          const q = quota.consume(requestCtx!.subject!);
          if (!q.allowed) {
            return Promise.resolve({ ok: false, error: { name: 'SubjectQuotaExceeded', message: `Your hourly ${labelOf(binding)} quota on this server is used up. Try again after ${new Date(q.resetAt).toISOString()}.` } });
          }
        }
        calls.set(binding, used + 1);
        return runWithSignal(ctx?.signal ?? signal, () => dispatch(sdk, req));
      },
    },
  );
}
