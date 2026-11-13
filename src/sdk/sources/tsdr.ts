import { HttpClient } from '../../util/httpClient.js';
import { TsdrClient } from '../tsdr-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export const TSDR_LABEL = 'USPTO TSDR (trademarks)';
export const TSDR_BASE_URL = 'https://tsdrapi.uspto.gov';

export function createTsdrSource(cfg: SourceConfig): Source {
  const key = cfg.tsdr.apiKey?.trim();
  const enabled = Boolean(key);
  const http = new HttpClient({
    baseUrl: cfg.tsdr.baseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.maxResponseBytes ? { maxResponseBytes: cfg.maxResponseBytes } : {}),
    ...(cfg.cacheMaxBytes ? { cacheMaxBytes: cfg.cacheMaxBytes } : {}),
    // Same policy as ODP: pause every caller >= 5 s after a 429, then retry once.
    retry429: true, min429PauseMs: 5000, label: TSDR_LABEL,
    ...(enabled ? { defaultHeaders: { 'USPTO-API-KEY': key! } } : {}),
    ...(cfg.tsdr.preflightLimiter ? { preflightLimiter: cfg.tsdr.preflightLimiter } : {}),
    ...(cfg.tsdr.gate ? { gate: cfg.tsdr.gate } : {}),
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  const client = new TsdrClient(http);
  return {
    name: 'tsdr',
    label: TSDR_LABEL,
    enabled,
    disabledReason: enabled ? undefined : 'TSDR requires its own API key (separate from the ODP key). Set USPTO_TSDR_API_KEY (free at https://account.uspto.gov/api-manager).',
    client,
    methods: Object.freeze({
      status: client.status,
      multiStatus: client.multiStatus,
      documents: client.documents,
      documentInfo: client.documentInfo,
      lastUpdate: client.lastUpdate,
    }),
    corpus: loadSourceCorpus('tsdr'),
  };
}
