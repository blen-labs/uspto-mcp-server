import { request, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { log } from './logger.js';
import { abortError, currentSignal, sleep } from './executionContext.js';

const decompressGzip = promisify(gunzip) as (buf: Buffer, opts: { maxOutputLength: number }) => Promise<Buffer>;

/**
 * Upper bound on an upstream's Retry-After when pausing every caller of that upstream: the full
 * not-before time is honored (a weekly quota resets up to 7 days later); this only guards against
 * absurd values.
 */
const MAX_GATE_PAUSE_MS = 8 * 24 * 60 * 60 * 1000;
/** Longest a single call sleeps before its one 429 retry; longer cooldowns fail the call instead. */
const MAX_RETRY_WAIT_MS = 30_000;

/** Largest upstream response body kept in memory (after decompression), by default. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HttpClientOptions {
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  cacheMaxItems?: number;
  /** Upper bound on the summed size of cached response bodies (UTF-16 code units). Default 32 MiB. */
  cacheMaxBytes?: number;
  dispatcher?: Dispatcher;
  defaultHeaders?: Record<string, string>;
  /**
   * Retry a 429 once, after the cooldown, when that cooldown is at most 30 s. Every 429 pauses the
   * gate (all callers of this upstream) for max(min429PauseMs, Retry-After). Default true.
   */
  retry429?: boolean;
  /**
   * Shortest pause after an upstream 429, whatever Retry-After says. USPTO asks clients not to
   * send another request for at least 5 seconds after a 429. Default 0.
   */
  min429PauseMs?: number;
  /** Largest response body accepted; bigger bodies fail with ResponseTooLarge. */
  maxResponseBytes?: number;
  preflightLimiter?: PreflightLimiter;
  /** Shared per-upstream admission control (see UpstreamGate). */
  gate?: UpstreamGateLike;
  /** Human name of the upstream, used in error messages and logs, e.g. 'USPTO Open Data Portal'. */
  label?: string;
}

/**
 * Budget check run for every real upstream attempt (retries included), after the cache, in-flight
 * dedupe and gate admission, just before the request is sent. May be async, e.g. account mode's
 * per-account limit kept in PostgreSQL.
 */
export interface PreflightLimiter { tryTake(): boolean | Promise<boolean>; secondsUntilNext?(): number }

/** What HttpClient needs from an UpstreamGate; injectable for tests. */
export interface UpstreamGateLike { acquire(signal?: AbortSignal): Promise<() => void>; pause(ms: number): void }

export type QueryValue = string | number | boolean | string[] | undefined;

export interface CallOptions {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  accept?: 'json' | 'xml' | 'text';
  /** JSON request body. */
  body?: unknown;
  /** application/x-www-form-urlencoded request body (mutually exclusive with `body`). */
  form?: Record<string, string | number | undefined>;
  /**
   * Cache and share a POST like a GET. Only for read-only POSTs (USPTO search endpoints); the
   * key includes the serialized body. GETs are always cacheable.
   */
  cacheable?: boolean;
  /** Abort the request (and any wait for a slot). Defaults to the current execution's signal. */
  signal?: AbortSignal;
}

interface InflightEntry { promise: Promise<unknown>; controller: AbortController; waiters: number; forget?: () => void }

interface Cached { status: number; body: unknown; size: number }

export class HttpClient {
  #defaultHeaders: Record<string, string>;
  private readonly cache: LRUCache<string, Cached>;
  private readonly cacheEnabled: boolean;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retry429: boolean;
  private readonly min429PauseMs: number;
  private readonly maxResponseBytes: number;
  private readonly dispatcher?: Dispatcher;
  private readonly preflightLimiter?: PreflightLimiter;
  private readonly gate?: UpstreamGateLike;
  private readonly label: string;
  /**
   * Identical requests already on the wire; later callers share the first one's result. The shared
   * request is aborted only when every caller waiting on it has aborted.
   */
  private readonly inflight = new Map<string, InflightEntry>();
  /** Credential values from defaultHeaders, scrubbed from every upstream body and error. */
  readonly #secrets: string[];

  constructor(opts: HttpClientOptions) {
    this.#defaultHeaders = opts.defaultHeaders ?? {};
    this.#secrets = Object.values(this.#defaultHeaders).filter(v => typeof v === 'string' && v.length >= 8);
    this.baseUrl = opts.baseUrl;
    this.userAgent = opts.userAgent ?? 'uspto-mcp-server/1.0 (+https://github.com/blen-labs/uspto-mcp-server)';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 3;
    this.retry429 = opts.retry429 ?? true;
    this.min429PauseMs = opts.min429PauseMs ?? 0;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.dispatcher = opts.dispatcher;
    this.preflightLimiter = opts.preflightLimiter;
    this.gate = opts.gate;
    this.label = opts.label ?? new URL(opts.baseUrl).host;
    const max = opts.cacheMaxItems ?? 2000;
    const ttl = opts.cacheTtlMs ?? 300_000;
    this.cacheEnabled = max > 0 && ttl > 0;
    const maxBytes = Math.max(opts.cacheMaxBytes ?? 32 * 1024 * 1024, 1024);
    this.cache = new LRUCache<string, Cached>({
      max: Math.max(max, 1), ttl: Math.max(ttl, 1),
      // A response bigger than the whole cache is simply not cached.
      maxSize: maxBytes, maxEntrySize: maxBytes, sizeCalculation: v => Math.max(1, v.size),
    });
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    if (o.body !== undefined && o.form !== undefined) throw new TypeError('Pass either body or form, not both');
    const url = this.buildUrl(o.path, o.query);
    const method = o.method ?? 'GET';
    const payload = o.form !== undefined ? encodeForm(o.form) : o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const key = method === 'GET' || o.cacheable ? this.cacheKey(method, url, payload, o) : '';
    if (key && this.cacheEnabled && this.cache.has(key)) {
      log.debug('http.cache_hit', { url });
      return this.cache.get(key)!.body as T;
    }
    const signal = o.signal ?? currentSignal();
    if (signal?.aborted) throw abortError();
    if (!key) return this.fetchWithRetry<T>(url, method, o, payload, key, signal);
    // Join an identical request already on the wire rather than queueing a second one.
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.fetchWithRetry<T>(url, method, o, payload, key, controller.signal);
      const created: InflightEntry = { promise, controller, waiters: 0 };
      const forget = () => { if (this.inflight.get(key) === created) this.inflight.delete(key); };
      created.forget = forget;
      entry = created;
      promise.then(forget, forget);
      promise.catch(() => { /* each waiter observes the rejection itself */ });
      this.inflight.set(key, created);
    }
    return this.wait<T>(entry, signal);
  }

  /** One caller's view of a shared request: it may abort its own wait without failing others. */
  private wait<T>(entry: InflightEntry, signal?: AbortSignal): Promise<T> {
    entry.waiters++;
    if (!signal) return entry.promise.finally(() => { entry.waiters--; }) as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return false; done = true; entry.waiters--; signal.removeEventListener('abort', onAbort); return true; };
      const onAbort = () => {
        if (!finish()) return;
        // Once nobody waits, the shared request is dying: later identical calls must start their own.
        if (entry.waiters === 0) { entry.forget?.(); entry.controller.abort(); }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(v => { if (finish()) resolve(v as T); }, e => { if (finish()) reject(e); });
    });
  }

  private async fetchWithRetry<T>(url: string, method: 'GET' | 'POST', o: CallOptions, payload: string | undefined, key: string, signal?: AbortSignal): Promise<T> {
    const accept =
      o.accept === 'xml' ? 'application/xml,text/xml'
      : o.accept === 'text' ? 'text/plain,*/*;q=0.5'
      : 'application/json';

    let attempt = 0;
    let retried429 = false;
    for (;;) {
      try {
        return await this.attempt<T>(url, method, o, payload, accept, key, signal);
      } catch (err) {
        if (err instanceof GateTimeoutError || err instanceof ResponseTooLargeError || (err as Error)?.name === 'AbortError') throw err;
        const status = err instanceof HttpError ? err.status : 0;
        if (status === 429 && !(err as HttpError).budget) {
          // attempt() already paused the gate before releasing its slot.
          const wait = this.pauseFor(err as HttpError);
          if (!this.retry429 || retried429 || wait > MAX_RETRY_WAIT_MS) throw err;
          retried429 = true;
          await sleep(wait, signal);
          continue;
        }
        const retryable = status === 0 || status >= 500;
        if (!retryable || attempt === this.retries) throw err;
        await sleep(Math.min(2 ** attempt * 250, 4000), signal);
        attempt++;
      }
    }
  }

  /** How long every caller of this upstream must wait after a 429. */
  private pauseFor(err: HttpError): number {
    return Math.min(MAX_GATE_PAUSE_MS, Math.max(this.min429PauseMs, err.retryAfterMs ?? 1000));
  }

  /** One request, holding a gate slot only while it is on the wire. */
  private async attempt<T>(url: string, method: 'GET' | 'POST', o: CallOptions, payload: string | undefined, accept: string, key: string, signal?: AbortSignal): Promise<T> {
    let release: (() => void) | undefined;
    if (this.gate) {
      try {
        release = await this.gate.acquire(signal);
      } catch (err) {
        const e = err as { name?: string; retryAfterMs?: number };
        if (e?.name === 'AbortError') throw abortError();
        if (e?.name === 'Paused') {
          const g = new GateTimeoutError(`${this.label} asked this server to wait ${Math.ceil((e.retryAfterMs ?? 0) / 1000)}s before calling again (rate limit). Retry later.`);
          g.retryAfterMs = e.retryAfterMs;
          throw g;
        }
        throw new GateTimeoutError(`${this.label} is busy: too many requests from this server are waiting. Make fewer calls per execute (USPTO allows one request at a time per API key) or retry shortly.`);
      }
    }
    // Absolute deadline for this attempt: connecting, headers and the whole body. undici's own
    // header/body timeouts are inactivity timers, which a slowly trickling response never trips.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      // Budgets count real upstream attempts (retries included), charged only once a request is
      // admitted and about to be sent.
      if (this.preflightLimiter && !(await this.preflightLimiter.tryTake())) {
        const wait = this.preflightLimiter.secondsUntilNext?.() ?? 0;
        const err = new HttpError(`${this.label}: this server's request budget for this API key is used up${Number.isFinite(wait) && wait > 0 ? ` (retry in ~${wait}s)` : ''}`, 429, '');
        err.name = 'RateLimited';
        err.budget = true;
        throw err;
      }
      const res = await request(url, {
        method,
        headers: {
          'accept': accept,
          'accept-encoding': 'gzip',
          'user-agent': this.userAgent,
          ...this.#defaultHeaders,
          ...(o.form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' }
            : o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(o.headers ?? {}),
        },
        body: payload,
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
        signal: requestSignal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });

      // A 429 pauses every caller now, from status and headers alone, before anything that could
      // fail (body read, decoding) and before this slot is released.
      if (res.statusCode === 429) {
        const rawRetryAfter = Array.isArray(res.headers['retry-after']) ? res.headers['retry-after'][0] : res.headers['retry-after'];
        const retryAfterMs = parseRetryAfter(rawRetryAfter);
        // Header text is upstream-controlled: scrub and bound it before it reaches logs or errors.
        const retryAfter = rawRetryAfter === undefined ? undefined : this.redact(String(rawRetryAfter)).slice(0, 64);
        this.gate?.pause(Math.min(MAX_GATE_PAUSE_MS, Math.max(this.min429PauseMs, retryAfterMs ?? 1000)));
        log.warn('upstream.rate_limited', { source: this.label, host: new URL(url).host, ...(retryAfter ? { retryAfter } : {}) });
        // Best effort only, after the pause is in place: the upstream's own words, if readable.
        let detail = '';
        try {
          const raw = await readCapped(res.body, res.headers['content-length'], 64 * 1024, `${method} ${url}`, true);
          const gz = String(res.headers['content-encoding'] ?? '').trim().toLowerCase() === 'gzip';
          detail = this.redact(new TextDecoder().decode(gz ? await decompressGzip(raw, { maxOutputLength: 64 * 1024 }) : raw)).slice(0, 2000);
        } catch { /* unreadable body: the status and headers were enough */ }
        const err = new HttpError(`${this.label} is rate limiting this API key: ${method} ${stripQuery(url)} -> 429 Too Many Requests${retryAfter ? ` (retry-after ${retryAfter})` : ''}. USPTO allows one request at a time per key and a weekly quota; slow down and retry later.`, 429, detail);
        err.name = 'RateLimited';
        err.retryAfterMs = retryAfterMs;
        throw err;
      }

      // undici.request returns raw bytes, unlike fetch. Decode before parsing,
      // reporting upstream errors, or caching the response.
      const raw = await readCapped(res.body, res.headers['content-length'], this.maxResponseBytes, `${method} ${url}`, res.statusCode >= 400);
      const encoding = res.headers['content-encoding'];
      const limit = res.statusCode >= 400 ? Math.min(this.maxResponseBytes, 64 * 1024) : this.maxResponseBytes;
      let bytes = raw;
      if (typeof encoding === 'string' && encoding.trim().toLowerCase() === 'gzip') {
        // Bound the expansion itself, not just the compressed size.
        try { bytes = await decompressGzip(raw, { maxOutputLength: limit + 1 }); }
        catch (err) {
          if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ResponseTooLargeError(`${method} ${url}`, this.maxResponseBytes);
          throw err;
        }
      }
      if (bytes.length > limit) {
        if (res.statusCode < 400) throw new ResponseTooLargeError(`${method} ${url}`, this.maxResponseBytes);
        bytes = bytes.subarray(0, limit);
      }
      const text = this.redact(new TextDecoder().decode(bytes));

      if (res.statusCode >= 400) {
        const err = new HttpError(`${this.label}: ${method} ${stripQuery(url)} -> ${res.statusCode}${upstreamDetail(text)}`, res.statusCode, text.slice(0, 2000));
        if (res.statusCode === 404) err.name = 'NotFound';
        if (res.statusCode === 401 || res.statusCode === 403) {
          err.name = 'Unauthorized';
          err.message = `${this.label} rejected the request (${res.statusCode}): the API key is missing, invalid, or not allowed to use this API.`;
        }
        err.message = this.redact(err.message);
        throw err;
      }

      const contentType = String(res.headers['content-type'] ?? '');
      let body: unknown;
      if (accept.startsWith('application/json') || /json/i.test(contentType)) {
        // Redact again after decoding: JSON escapes can spell a credential the raw scan missed.
        try { body = text.length ? this.redactValue(JSON.parse(text)) : null; }
        catch { body = text; }
      } else body = text;
      if (key && this.cacheEnabled) this.cache.set(key, { status: res.statusCode, body, size: text.length });
      return body as T;
    } catch (err) {
      if (signal?.aborted) throw abortError();
      if (deadline.signal.aborted) {
        const e = new HttpError(`${this.label}: ${method} ${stripQuery(url)} did not complete within ${this.timeoutMs} ms`, 0, '');
        e.name = 'UpstreamTimeout';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      release?.();
    }
  }

  /** Deep redaction of a decoded JSON value, including object keys. */
  private redactValue(value: unknown): unknown {
    if (!this.#secrets.length) return value;
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(v => this.redactValue(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.redact(k), this.redactValue(v)]));
    }
    return value;
  }

  /** Replace any configured credential that an upstream echoes back. */
  private redact(text: string): string {
    let out = text;
    for (const secret of this.#secrets) if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    return out;
  }

  private cacheKey(method: string, url: string, payload: string | undefined, o: CallOptions): string {
    const merged = { ...this.#defaultHeaders, ...(o.headers ?? {}) };
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) normalized[k.toLowerCase()] = v;
    // Credentials are folded into a digest so the key never holds them in clear text, and two
    // API keys never share cached responses.
    const hash = createHash('sha256')
      .update(JSON.stringify({ h: normalized, b: payload ?? null, a: o.accept ?? 'json', f: o.form !== undefined }))
      .digest('hex').slice(0, 24);
    return `${method} ${url}\n${hash}`;
  }

  private buildUrl(path: string, query?: CallOptions['query']): string {
    const base = this.baseUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : '/' + path;
    const url = new URL(base + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
        else url.searchParams.append(k, String(v));
      }
    }
    return url.toString();
  }
}

function encodeForm(form: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) p.append(k, String(v));
  return p.toString();
}

/** Error bodies can echo the query string; keep messages to the path. */
function stripQuery(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

/** A short, human-readable reason from a USPTO JSON error body ({ error, errorDetails, message }). */
function upstreamDetail(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const parts = [j.error, j.errorDetails, j.message, j.detailedMessage].filter(v => typeof v === 'string' && v.trim()) as string[];
    const detail = [...new Set(parts)].join(' — ').slice(0, 300);
    return detail ? `: ${detail}` : '';
  } catch {
    return '';
  }
}

/** Read a response body, failing fast once it exceeds `max` bytes. */
async function readCapped(
  body: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
  contentLength: string | string[] | undefined,
  max: number,
  what: string,
  isError: boolean,
): Promise<Buffer> {
  // Error bodies are only used for a short message; never buffer a huge one.
  const limit = isError ? Math.min(max, 64 * 1024) : max;
  const declared = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (!isError && Number.isFinite(declared) && declared > limit) {
    body.destroy?.();
    throw new ResponseTooLargeError(what, max);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) {
      body.destroy?.();
      if (isError) break;
      throw new ResponseTooLargeError(what, max);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; undefined if absent or invalid. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  // Check numerics first: Date.parse('1.5') is a valid date in V8 (2001), not 1.5 seconds.
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  if (/^[\d.]+$/.test(v)) return undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export class HttpError extends Error {
  retryAfterMs?: number;
  /** Raised by this server's own budget, not by the upstream: never retried, never pauses the gate. */
  budget?: boolean;
  constructor(message: string, public readonly status: number, public readonly bodySnippet: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** No gate slot freed up within maxWaitMs. Never retried: the queue is already full. */
class GateTimeoutError extends HttpError {
  constructor(message: string) {
    super(message, 429, '');
    this.name = 'RateLimited';
  }
}

/** The upstream body exceeded maxResponseBytes. Never retried. */
export class ResponseTooLargeError extends HttpError {
  constructor(what: string, max: number) {
    super(`${what.split('?')[0]} returned more than ${Math.round(max / 1024 / 1024)} MB. Request fewer results (smaller limit, or select fields) and paginate.`, 0, '');
    this.name = 'ResponseTooLarge';
  }
}
