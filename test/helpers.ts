import type { Dispatcher } from 'undici';
import type { SourceConfig } from '../src/sdk/sources/source.js';
import { LIMIT_DEFAULTS, type SupervisorConfig } from '../src/supervisor/index.js';

export const ODP_ORIGIN = 'https://api.uspto.gov';
export const TSDR_ORIGIN = 'https://tsdrapi.uspto.gov';

/** A SourceConfig with no keys, no cache, no retries. */
export function sourceCfg(opts: { odpKey?: string; tsdrKey?: string; dispatcher?: Dispatcher } = {}): SourceConfig {
  return {
    odp: { baseUrl: ODP_ORIGIN, ...(opts.odpKey ? { apiKey: opts.odpKey } : {}) },
    tsdr: { baseUrl: TSDR_ORIGIN, ...(opts.tsdrKey ? { apiKey: opts.tsdrKey } : {}) },
    userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  };
}

/** A SupervisorConfig suitable for tests (fast gates, no cache). */
export function supervisorCfg(extra: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    odpBaseUrl: ODP_ORIGIN, tsdrBaseUrl: TSDR_ORIGIN,
    userAgent: 'test/0.0', upstreamTimeoutMs: 5000, upstreamRetries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
    sandbox: 'auto',
    limits: {
      odp: { ...LIMIT_DEFAULTS.odp, ratePerSec: 1000 },
      tsdr: { ...LIMIT_DEFAULTS.tsdr, ratePerSec: 1000 },
    },
    ...extra,
  };
}
