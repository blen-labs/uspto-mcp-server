import { HttpClient } from '../../util/httpClient.js';
import { OdpClient } from '../odp-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export const ODP_LABEL = 'USPTO Open Data Portal';
export const ODP_BASE_URL = 'https://api.uspto.gov';

export function createOdpSource(cfg: SourceConfig): Source {
  const key = cfg.odp.apiKey?.trim();
  const enabled = Boolean(key);
  const http = new HttpClient({
    baseUrl: cfg.odp.baseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.maxResponseBytes ? { maxResponseBytes: cfg.maxResponseBytes } : {}),
    ...(cfg.cacheMaxBytes ? { cacheMaxBytes: cfg.cacheMaxBytes } : {}),
    // USPTO: "We strongly discourage automatic retries, without at least 5 second delay" after a 429.
    // Every caller of this key pauses >= 5 s (or Retry-After), then a request is retried once.
    // Observed live: a 429 can arrive even at one request in flight and the documented rate.
    retry429: true, min429PauseMs: 5000, label: ODP_LABEL,
    ...(enabled ? { defaultHeaders: { 'X-API-KEY': key! } } : {}),
    ...(cfg.odp.preflightLimiter ? { preflightLimiter: cfg.odp.preflightLimiter } : {}),
    ...(cfg.odp.gate ? { gate: cfg.odp.gate } : {}),
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  const client = new OdpClient(http);
  const { patents, ptab, petitions, officeActions, oa, bulk } = client;
  return {
    name: 'odp',
    label: ODP_LABEL,
    enabled,
    disabledReason: enabled ? undefined : 'The USPTO Open Data Portal requires an API key. Set USPTO_API_KEY (free: sign in at https://data.uspto.gov/myodp, verify with ID.me, then request a key).',
    client,
    methods: Object.freeze({
      'patents.search': patents.search,
      'patents.get': patents.get,
      'patents.byPatentNumber': patents.byPatentNumber,
      'patents.metaData': patents.metaData,
      'patents.adjustment': patents.adjustment,
      'patents.assignment': patents.assignment,
      'patents.attorney': patents.attorney,
      'patents.continuity': patents.continuity,
      'patents.foreignPriority': patents.foreignPriority,
      'patents.transactions': patents.transactions,
      'patents.documents': patents.documents,
      'patents.associatedDocuments': patents.associatedDocuments,
      'patents.statusCodes': patents.statusCodes,
      'ptab.proceedings.search': ptab.proceedings.search,
      'ptab.proceedings.get': ptab.proceedings.get,
      'ptab.decisions.search': ptab.decisions.search,
      'ptab.decisions.get': ptab.decisions.get,
      'ptab.decisions.byTrial': ptab.decisions.byTrial,
      'ptab.documents.search': ptab.documents.search,
      'ptab.documents.get': ptab.documents.get,
      'ptab.documents.byTrial': ptab.documents.byTrial,
      'ptab.appeals.search': ptab.appeals.search,
      'ptab.appeals.get': ptab.appeals.get,
      'ptab.appeals.byAppeal': ptab.appeals.byAppeal,
      'ptab.interferences.search': ptab.interferences.search,
      'ptab.interferences.get': ptab.interferences.get,
      'ptab.interferences.byInterference': ptab.interferences.byInterference,
      'petitions.search': petitions.search,
      'petitions.get': petitions.get,
      'officeActions.search': officeActions.search,
      'officeActions.get': officeActions.get,
      'officeActions.text': officeActions.text,
      'oa.text.search': oa.text.search,
      'oa.text.fields': oa.text.fields,
      'oa.citations.search': oa.citations.search,
      'oa.citations.fields': oa.citations.fields,
      'oa.rejections.search': oa.rejections.search,
      'oa.rejections.fields': oa.rejections.fields,
      'oa.enrichedCitations.search': oa.enrichedCitations.search,
      'oa.enrichedCitations.fields': oa.enrichedCitations.fields,
      'bulk.search': bulk.search,
      'bulk.get': bulk.get,
    }),
    corpus: loadSourceCorpus('odp'),
  };
}
