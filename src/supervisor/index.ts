import { sdkFromSources } from '../sdk/bindings.js';
import { getSources } from '../sdk/sources/index.js';
import type { SourceConfig, SourceName } from '../sdk/sources/source.js';
import { buildCorpus } from '../search/corpus.js';
import { pickSandbox } from '../sandbox/index.js';
import { TokenBucket } from '../util/tokenBucket.js';
import { UpstreamGate } from '../util/upstreamGate.js';
import { SubjectQuota } from '../util/quotas.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SandboxKind } from '../sandbox/types.js';
import { ExecutionLimiter } from '../util/executionLimiter.js';

/** Guardrails for one API-key-gated upstream. */
export interface KeyedLimits {
  /** Upstream calls one execute() may make. */
  maxCallsPerExecute: number;
  /** Process-wide hourly cap on the operator's shared key (after the cache). */
  ratePerHour: number;
  /** Per-subject hourly cap (HTTP transport only; stdio has no subject). */
  subjectRatePerHour: number;
  /** Requests in flight per API key. USPTO blocks concurrent requests with one key: keep 1. */
  concurrency: number;
  /** Requests started per second per API key. */
  ratePerSec: number;
  /** Longest a call waits for a slot before failing with RateLimited. */
  maxWaitMs: number;
}

/**
 * Defaults from https://data.uspto.gov/apis/api-rate-limits (burst 1 per key, 4-15 requests/s,
 * 5M metadata + 1.2M document calls per week) and the TSDR key guide (60 requests/min).
 */
export const LIMIT_DEFAULTS: Readonly<Record<SourceName, Readonly<KeyedLimits>>> = Object.freeze({
  odp: Object.freeze({ maxCallsPerExecute: 50, ratePerHour: 5000, subjectRatePerHour: 1000, concurrency: 1, ratePerSec: 4, maxWaitMs: 30_000 }),
  tsdr: Object.freeze({ maxCallsPerExecute: 25, ratePerHour: 3000, subjectRatePerHour: 600, concurrency: 1, ratePerSec: 1, maxWaitMs: 30_000 }),
});

export interface SupervisorConfig {
  odpBaseUrl: string;
  odpApiKey?: string;
  tsdrBaseUrl: string;
  tsdrApiKey?: string;
  userAgent: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  maxResponseBytes?: number;
  sandbox: SandboxKind;
  /** Prefer a process-isolated sandbox for `auto` (multi-user HTTP serving). */
  processIsolation?: boolean;
  limits: Record<SourceName, KeyedLimits>;
  /** Simultaneous executions, server-wide and per subject. */
  maxConcurrentExecutions?: number;
  maxExecutionsPerSubject?: number;
  /** Aborts every execution (graceful shutdown). */
  shutdownSignal?: AbortSignal;
}

export const EXECUTION_DEFAULTS = { maxConcurrent: 8, perSubject: 2 } as const;

export function keyGate(l: KeyedLimits): UpstreamGate {
  return new UpstreamGate({
    concurrency: l.concurrency, ratePerSec: l.ratePerSec,
    // Never let a burst defeat the per-second pacing USPTO asks for.
    burst: 1, maxWaitMs: l.maxWaitMs,
  });
}

/** The parts of SourceConfig that do not depend on which key is used. */
export function baseSourceConfig(cfg: SupervisorConfig): Omit<SourceConfig, 'odp' | 'tsdr'> {
  return {
    userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs, retries: cfg.upstreamRetries,
    cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.maxResponseBytes ? { maxResponseBytes: cfg.maxResponseBytes } : {}),
  };
}

export async function buildSupervisor(cfg: SupervisorConfig): Promise<CatalogDeps> {
  const { odp, tsdr } = cfg.limits;
  // One limiter and one gate per shared key.
  const sourceCfg: SourceConfig = {
    ...baseSourceConfig(cfg),
    odp: {
      baseUrl: cfg.odpBaseUrl, apiKey: cfg.odpApiKey,
      preflightLimiter: new TokenBucket(odp.ratePerHour / 3600, odp.ratePerHour), gate: keyGate(odp),
    },
    tsdr: {
      baseUrl: cfg.tsdrBaseUrl, apiKey: cfg.tsdrApiKey,
      preflightLimiter: new TokenBucket(tsdr.ratePerHour / 3600, tsdr.ratePerHour), gate: keyGate(tsdr),
    },
  };
  const sources = getSources(sourceCfg);
  const sdk = sdkFromSources(sources);
  const corpus = buildCorpus(sources);
  const sandbox = await pickSandbox(cfg.sandbox, { processIsolation: cfg.processIsolation });
  return {
    sdk, sandbox, corpus,
    executionLimiter: new ExecutionLimiter(
      cfg.maxConcurrentExecutions ?? EXECUTION_DEFAULTS.maxConcurrent,
      cfg.maxExecutionsPerSubject ?? EXECUTION_DEFAULTS.perSubject,
    ),
    ...(cfg.shutdownSignal ? { shutdownSignal: cfg.shutdownSignal } : {}),
    callBudgets: { odp: odp.maxCallsPerExecute, tsdr: tsdr.maxCallsPerExecute },
    subjectQuotas: {
      odp: new SubjectQuota(odp.subjectRatePerHour, 60 * 60 * 1000),
      tsdr: new SubjectQuota(tsdr.subjectRatePerHour, 60 * 60 * 1000),
    },
  };
}
