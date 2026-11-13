#!/usr/bin/env node
import { startStdio } from './server/stdio.js';
import { startHttp, type HttpHandle } from './server/http.js';
import { buildSupervisor, EXECUTION_DEFAULTS, LIMIT_DEFAULTS, type KeyedLimits, type SupervisorConfig } from './supervisor/index.js';
import { ODP_BASE_URL } from './sdk/sources/odp.js';
import { TSDR_BASE_URL } from './sdk/sources/tsdr.js';
import type { SourceName } from './sdk/sources/source.js';
import { DEFAULT_MAX_RESPONSE_BYTES } from './util/httpClient.js';
import type { SandboxKind } from './sandbox/types.js';
import { log } from './util/logger.js';
import type { AuthProvider } from './server/authz.js';

interface CliArgs {
  http: boolean;
  port: number;
  host: string;
  /** True when HOST or --host chose the bind address explicitly. */
  hostExplicit: boolean;
  sandbox: SandboxKind;
  insecure: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    http: false,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? '0.0.0.0',
    hostExplicit: Boolean(process.env.HOST),
    sandbox: (process.env.USPTO_SANDBOX as SandboxKind | undefined) ?? 'auto',
    insecure: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') args.http = true;
    else if (a === '--insecure') args.insecure = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') { args.host = String(argv[++i]); args.hostExplicit = true; }
    else if (a === '--sandbox') args.sandbox = argv[++i] as SandboxKind;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  if (!['auto', 'isolate', 'deno'].includes(args.sandbox)) throw new Error(`Unknown sandbox '${args.sandbox}'. Use auto, isolate or deno.`);
  // An unauthenticated server listens on loopback unless told otherwise.
  if (args.insecure && !args.hostExplicit) args.host = '127.0.0.1';
  return args;
}

function printHelp(): void {
  process.stdout.write(`uspto-mcp-server [options]

  --http                 Run Streamable HTTP transport (default: stdio)
  --port N               HTTP port (default 8080, env PORT)
  --host H               HTTP bind host (default 0.0.0.0; 127.0.0.1 with --insecure; env HOST)
  --sandbox auto|isolate|deno
                         Sandbox runner (default auto, env USPTO_SANDBOX)
  --insecure             HTTP without authentication (local development; binds loopback by default)
  -h, --help             Show this help
`);
}

/** A positive number (and at least `min`) from the environment, or `fallback` when unset or invalid. */
function positive(value: string | undefined, fallback: number, min = 0): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 && n >= min ? n : fallback;
}

/**
 * A secret from the environment, or undefined when unset, blank, or an unexpanded host
 * placeholder (an MCPB host may pass '${user_config.x}' literally for an optional field left empty).
 */
function secret(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
}

/** A non-negative integer from the environment, or `fallback` when unset or invalid. */
function nonNegativeInt(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** A number >= 1 from the environment, or `fallback` when unset or invalid. */
function atLeastOne(value: string | undefined, fallback: number): number {
  return positive(value, fallback, 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const accounts = args.http && process.env.USPTO_AUTH_PROVIDER === 'accounts';
  if (accounts && args.insecure) throw new Error('Account authentication cannot be combined with --insecure');
  const env = process.env;
  const shutdownController = new AbortController();
  const limits = (name: SourceName): KeyedLimits => {
    const d = LIMIT_DEFAULTS[name];
    const p = `USPTO_${name.toUpperCase()}_`;
    return {
      // 0 is a valid budget ("no calls"), but to disable a source leave its key unset instead.
      maxCallsPerExecute: nonNegativeInt(env[`${p}MAX_CALLS_PER_EXECUTE`], d.maxCallsPerExecute),
      // Require >= 1: a rate of 0 would silently block ALL calls (it is NOT "unlimited").
      ratePerHour: atLeastOne(env[`${p}RATE_PER_HOUR`], d.ratePerHour),
      subjectRatePerHour: atLeastOne(env[`${p}SUBJECT_RATE_PER_HOUR`], d.subjectRatePerHour),
      // USPTO blocks parallel requests on one key; raising this mostly produces 429s.
      concurrency: atLeastOne(env[`${p}CONCURRENCY`], d.concurrency),
      ratePerSec: positive(env[`${p}RATE_PER_SEC`], d.ratePerSec),
      maxWaitMs: atLeastOne(env[`${p}MAX_WAIT_MS`], d.maxWaitMs),
    };
  };
  const cfg: SupervisorConfig = {
    odpBaseUrl: env.USPTO_ODP_BASE_URL ?? ODP_BASE_URL,
    tsdrBaseUrl: env.USPTO_TSDR_BASE_URL ?? TSDR_BASE_URL,
    // Personal keys for stdio and self-hosted single-user HTTP. Account mode never uses them for
    // anyone (USPTO keys must not be shared): signed-in users use only their own saved keys.
    odpApiKey: secret(env.USPTO_API_KEY),
    tsdrApiKey: secret(env.USPTO_TSDR_API_KEY),
    userAgent: env.USPTO_USER_AGENT ?? 'uspto-mcp-server/0.1 (+https://github.com/blen-labs/uspto-mcp-server)',
    upstreamTimeoutMs: atLeastOne(env.USPTO_UPSTREAM_TIMEOUT_MS, 30_000),
    upstreamRetries: nonNegativeInt(env.USPTO_UPSTREAM_RETRIES, 2),
    cacheTtlMs: nonNegativeInt(env.USPTO_CACHE_TTL_MS, 600_000),
    cacheMaxItems: nonNegativeInt(env.USPTO_CACHE_MAX_ITEMS, 1000),
    maxResponseBytes: atLeastOne(env.USPTO_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
    sandbox: args.sandbox,
    // Authenticated HTTP serves many users: user code must run out of process (Deno only).
    processIsolation: args.http && !args.insecure,
    limits: { odp: limits('odp'), tsdr: limits('tsdr') },
    maxConcurrentExecutions: atLeastOne(env.USPTO_MAX_CONCURRENT_EXECUTIONS, EXECUTION_DEFAULTS.maxConcurrent),
    maxExecutionsPerSubject: atLeastOne(env.USPTO_MAX_EXECUTIONS_PER_SUBJECT, EXECUTION_DEFAULTS.perSubject),
    shutdownSignal: shutdownController.signal,
  };
  const deps = await buildSupervisor(cfg);
  // Base --http with real auth serves every token holder through the process keys. USPTO keys are
  // personal, so that mode is for one owner (yourself behind your own IdP); multi-user hosting
  // must use USPTO_AUTH_PROVIDER=accounts, where each user brings their own key.
  if (args.http && !accounts && !args.insecure && (cfg.odpApiKey || cfg.tsdrApiKey)) {
    log.warn('http.personal_keys_shared', { note: 'USPTO keys are personal: every authenticated caller uses this server\'s keys. Use USPTO_AUTH_PROVIDER=accounts for multiple users.' });
  }

  let handle: HttpHandle | undefined;

  if (accounts) {
    const { loadAccountConfig } = await import('./accounts/config.js');
    const { startAccountHttp } = await import('./accounts/runtime.js');
    handle = await startAccountHttp(deps, cfg, loadAccountConfig(process.env), args.port, args.host);
  } else if (args.http) {
    const allowedOrigins = process.env.USPTO_ALLOWED_ORIGINS
      ? process.env.USPTO_ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : undefined;
    const allowedHosts = process.env.USPTO_ALLOWED_HOSTS
      ? process.env.USPTO_ALLOWED_HOSTS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : undefined;

    handle = await startHttp(deps, {
      port: args.port,
      host: args.host,
      // rps must be > 0 (a NaN or non-positive rate makes the bucket arithmetic meaningless);
      // burst must be >= 1, since a bucket that can never hold a whole token rejects everything.
      rps: positive(process.env.USPTO_IP_RPS, 5),
      burst: positive(process.env.USPTO_IP_BURST, 20, 1),
      clientIpHeader: (() => {
        const name = process.env.USPTO_CLIENT_IP_HEADER?.trim().toLowerCase();
        if (!name) return undefined;
        if (/^[a-z0-9-]+$/.test(name)) return name;
        log.warn('config.invalid_client_ip_header', { header: name });
        return undefined;
      })(),
      // An empty or invalid value falls back to the default (Number('') is 0, which would allow one request a day).
      subjectDailyQuota: atLeastOne(process.env.USPTO_SUBJECT_DAILY_QUOTA, 10_000),
      insecure: args.insecure,
      allowedHosts,
      allowedOrigins,
      publicOrigin: process.env.USPTO_PUBLIC_ORIGIN,
      auth: {
        provider: (process.env.USPTO_AUTH_PROVIDER ?? 'none') as AuthProvider,
        issuer: process.env.USPTO_AUTH_ISSUER,
        audience: process.env.USPTO_AUTH_AUDIENCE,
        jwksUrl: process.env.USPTO_AUTH_JWKS_URL,
        scopes: process.env.USPTO_AUTH_SCOPES?.split(',').map(s => s.trim()).filter(Boolean),
      },
    });
  } else {
    await startStdio(deps);
  }

  // Graceful shutdown (Railway sends SIGTERM, K8s sends SIGTERM, Ctrl-C sends SIGINT)
  const shutdown = async (signal: string) => {
    log.info('shutdown.start', { signal });
    shutdownController.abort();
    try {
      if (handle) await handle.close();
    } catch (err) {
      log.warn('shutdown.error', { error: (err as Error).message });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}


main().catch(err => {
  log.error('bin.fatal', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
