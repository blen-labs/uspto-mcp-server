import type { Dispatcher } from 'undici';
import type { CorpusEntry } from '../../search/corpus.js';
import type { PreflightLimiter, UpstreamGateLike } from '../../util/httpClient.js';

export interface SourceMeta {
  name: string;          // sandbox global + RPC binding id
  label: string;         // human label, e.g. 'USPTO Open Data Portal'
  enabled: boolean;      // false when a required secret is missing
  disabledReason?: string;
}

export interface Source extends SourceMeta {
  client: object;        // host-side client, never traversed by sandbox RPC
  methods: RpcMethods;   // explicit public dotted paths, relative to the binding
  corpus: { endpoints: CorpusEntry[]; fields: CorpusEntry[] };
}

// Each registered function retains its concrete argument contract at registration.
// Runtime arguments cross the sandbox bridge as data, never as host references.
export type RpcMethods = Readonly<Record<string, (...args: any[]) => unknown>>;

/** One API-key-gated upstream. The key stays host-side, inside the source's HttpClient. */
export interface KeyedUpstream {
  baseUrl: string;
  apiKey?: string;
  /** Hourly budget check, run after the response cache (process-wide, or per account). */
  preflightLimiter?: PreflightLimiter;
  /** Per-key admission control: USPTO allows one request in flight per API key. */
  gate?: UpstreamGateLike;
}

export interface SourceConfig {
  odp: KeyedUpstream;
  tsdr: KeyedUpstream;
  userAgent: string;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  /** Summed size bound for one client's response cache. */
  cacheMaxBytes?: number;
  maxResponseBytes?: number;
  dispatcher?: Dispatcher;
}

/** Names of the keyed sources, i.e. every source this server registers. */
export const SOURCE_NAMES = ['odp', 'tsdr'] as const;
export type SourceName = typeof SOURCE_NAMES[number];
