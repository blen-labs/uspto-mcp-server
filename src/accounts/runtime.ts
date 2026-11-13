import { createServer } from 'node:http';
import { Pool } from 'pg';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SupervisorConfig } from '../supervisor/index.js';
import type { HttpHandle } from '../server/http.js';
import type { Dispatcher } from 'undici';
import { log } from '../util/logger.js';
import { createOdpSource, ODP_BASE_URL } from '../sdk/sources/odp.js';
import { createTsdrSource, TSDR_BASE_URL } from '../sdk/sources/tsdr.js';
import type { Source, SourceConfig } from '../sdk/sources/source.js';
import { baseSourceConfig } from '../supervisor/index.js';
import { configureKeyGates, gateHandle } from './keyGates.js';
import { LRUCache } from 'lru-cache';
import { createAccountApp } from './app.js';
import { ACCOUNT_MCP_PATH } from './paths.js';
import { digest } from './crypto.js';
import { Store, personalOwner, KEY_KINDS, isKeyKind, type KeyKind } from './store.js';
import type { AccountConfig } from './config.js';

/** Account-scoped keyed clients, reused across executes so their response caches survive. */
const ACCOUNT_CLIENT_MAX = 500;
const ACCOUNT_CLIENT_TTL_MS = 60 * 60 * 1000;
/** Per-account response cache caps: up to ACCOUNT_CLIENT_MAX of these caches live at once. */
const ACCOUNT_CACHE_MAX_ITEMS = 100;
const ACCOUNT_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const unavailable = (message: string) => Object.assign(new Error(message), { name: 'SourceUnavailable' });

type KeyedFactory = (cfg: SourceConfig) => Source;
const FACTORIES: Record<KeyKind, { create: KeyedFactory; baseUrl: string; label: string }> = {
  odp: { create: createOdpSource, baseUrl: ODP_BASE_URL, label: 'USPTO Open Data Portal' },
  tsdr: { create: createTsdrSource, baseUrl: TSDR_BASE_URL, label: 'USPTO TSDR' },
};

/**
 * Keep the process's catalog shape, but route every keyed source through the caller's own key.
 * Each method loads the caller's key for that source on first use, so code that only calls
 * `odp` never reads the TSDR key and vice versa. Clients are cached by a digest of owner + kind
 * + key: the key is read on every execute that uses the source, so a saved, rotated or deleted
 * key takes effect on the next call on every replica, while identical queries still hit the
 * client's response cache. Admission is per credential (keyGates.ts), shared by every client and key
 * check that uses the key, so it has one request in flight in this process (USPTO blocks concurrent
 * requests with one key). Single replica only: other processes do not share these gates.
 */
export function accountDependencies(deps: CatalogDeps, cfg: SupervisorConfig, store: Store, dispatcher?: Dispatcher): CatalogDeps {
  configureKeyGates(cfg.limits);
  // Even if the process has shared keys, never put them in the hosted account catalog.
  const clients = Object.fromEntries(Object.entries(deps.sdk.clients).filter(([name]) => !isKeyKind(name)));
  const methods = Object.fromEntries(Object.entries(deps.sdk.methods).filter(([name]) => !isKeyKind(name)));
  const sdk = { ...deps.sdk, clients, methods: Object.freeze(methods) };
  const accountCfg = (kind: KeyKind, key?: string): SourceConfig => {
    const base = baseSourceConfig(cfg);
    const upstream = (k: KeyKind) => ({
      // Account credentials can never be redirected by an operator's upstream override.
      baseUrl: FACTORIES[k].baseUrl,
      ...(k === kind && key ? { apiKey: key } : {}),
    });
    return {
      ...base, retries: Math.min(base.retries, 1),
      cacheMaxItems: Math.min(cfg.cacheMaxItems, ACCOUNT_CACHE_MAX_ITEMS), cacheMaxBytes: ACCOUNT_CACHE_MAX_BYTES,
      odp: upstream('odp'), tsdr: upstream('tsdr'),
      ...(dispatcher ? { dispatcher } : {}),
    };
  };
  // A keyless source still registers every method; only the names are needed here.
  const names = Object.fromEntries(KEY_KINDS.map(kind => [kind, Object.keys(FACTORIES[kind].create(accountCfg(kind)).methods)])) as Record<KeyKind, string[]>;
  const sources = new LRUCache<string, Source>({ max: ACCOUNT_CLIENT_MAX, ttl: ACCOUNT_CLIENT_TTL_MS });
  const sourceFor = (owner: string, kind: KeyKind, key: string) => {
    const id = digest(`${owner}\0${kind}\0${key}`);
    let source = sources.get(id);
    if (!source) {
      const base = accountCfg(kind, key);
      const limits = cfg.limits[kind];
      source = FACTORIES[kind].create({
        ...base,
        [kind]: {
          ...base[kind],
          gate: gateHandle(kind, key, limits),
          // The hourly account limit runs after the client's cache and in-flight dedupe, like the
          // process-wide bucket in key mode, so repeated identical calls do not spend the quota.
          preflightLimiter: { tryTake: () => store.allow(`${kind}:${owner}`, limits.ratePerHour, 3600) },
        },
      });
      sources.set(id, source);
    }
    return source;
  };
  return {
    ...deps, sdk,
    // Account mode limits keyed sources per account in PostgreSQL; the in-memory per-subject
    // quotas would cap accounts below that, and inconsistently across replicas.
    subjectQuotas: undefined,
    sdkForSubject: async subject => {
      if (!subject || subject === 'anonymous') throw new Error('An authenticated account is required');
      const owner = personalOwner(subject);
      const accountMethods: Record<string, Readonly<Record<string, (...args: unknown[]) => Promise<unknown>>>> = {};
      for (const kind of KEY_KINDS) {
        const label = FACTORIES[kind].label;
        // Loaded at most once per execute, and only if the code calls this source.
        let loaded: Promise<string | undefined> | undefined;
        const loadKey = () => loaded ??= store.getKey(owner, kind).catch(err => {
          // A transient database error or a retired encryption key must not break the other source.
          log.warn('account.key_unavailable', { kind, name: (err as Error).name });
          throw unavailable(`Your saved ${label} API key could not be loaded. Try again, or save it again at /account.`);
        });
        accountMethods[kind] = Object.freeze(Object.fromEntries(names[kind].map(name => [name, async (...args: unknown[]) => {
          const key = await loadKey();
          if (!key) throw unavailable(`Save your ${label} API key in your account at /account.`);
          const method = sourceFor(owner, kind, key).methods[name]!;
          const redact = (text: string) => text.split(key).join('[REDACTED]');
          let value: unknown;
          try {
            value = await method(...args);
          } catch (err) {
            // Keep the error's name and status (404 for a bad id, RateLimited for 429) so callers can
            // react; scrub the key from the message and never forward the upstream body.
            const e = err as { name?: unknown; message?: unknown; status?: unknown };
            const status = typeof e.status === 'number' ? e.status : undefined;
            throw Object.assign(
              new Error(redact(typeof e.message === 'string' && e.message ? e.message : `${label} request failed`)),
              { name: typeof e.name === 'string' ? e.name : 'Error', ...(status === undefined ? {} : { status }) },
            );
          }
          // Defensive redaction if an upstream ever echoes a credential, including object keys.
          const json = JSON.stringify(value);
          return json?.includes(key) ? JSON.parse(redact(json)) : value;
        }])));
      }
      return { ...sdk, methods: Object.freeze({ ...sdk.methods, ...accountMethods }) };
    },
  };
}

/**
 * The anonymous endpoint's catalog: documentation tools only. USPTO keys are personal ("Do not
 * share it with others", data.uspto.gov/apis/getting-started), so no operator key serves anyone
 * here, and without a key there is nothing for `execute` to do — it is not registered, so a
 * direct call fails as an unknown tool. Signed-in users get everything at ACCOUNT_MCP_PATH.
 */
export function publicDependencies(deps: CatalogDeps, origin: string): CatalogDeps {
  const methods = Object.fromEntries(Object.entries(deps.sdk.methods).filter(([name]) => !isKeyKind(name)));
  const clients = Object.fromEntries(Object.entries(deps.sdk.clients).filter(([name]) => !isKeyKind(name)));
  const meta = deps.sdk.meta.map(m => isKeyKind(m.name)
    ? { ...m, enabled: false, disabledReason: `${FACTORIES[m.name].label} needs your own API key. Connect ${origin}${ACCOUNT_MCP_PATH} instead: sign in with Google and add your key.` }
    : m);
  return { ...deps, tools: ['search_api', 'describe_schema'], sdk: { ...deps.sdk, methods: Object.freeze(methods), clients, meta } };
}

export async function startAccountHttp(deps: CatalogDeps, cfg: SupervisorConfig, config: AccountConfig, port: number, host: string): Promise<HttpHandle> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on('error', () => log.error('account.database_error'));
  const store = new Store(pool, config.keyring);
  let service: Awaited<ReturnType<typeof createAccountApp>> | undefined;
  try {
    await store.initialize();
    // USPTO keys are personal: in account mode a process-level key is never used for anyone.
    for (const kind of KEY_KINDS) if (deps.sdk.methods[kind]) log.warn('account.shared_key_ignored', { kind, note: 'USPTO API keys are personal; account mode uses only each user\'s own key' });
    service = await createAccountApp(config, store, accountDependencies(deps, cfg, store), fetch, publicDependencies(deps, config.origin));
    const server = createServer(service.app);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const cleanup = setInterval(() => { void store.cleanup().catch(() => log.error('account.cleanup_failed')); }, 60_000);
    cleanup.unref();
    return {
      port: (server.address() as { port: number }).port,
      close: async () => {
        clearInterval(cleanup);
        await service!.close();
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        await pool.end();
      },
    };
  } catch (error) {
    await service?.close();
    await pool.end();
    throw error;
  }
}
