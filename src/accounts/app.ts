import express from 'express';
import { Pool } from 'pg';
import { stripAccessTokenAuthorizationScheme } from 'better-auth/oauth2';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer, MCP_PROTOCOL_VERSION } from '../server/mcpServer.js';
import { readBuildInfo, type BuildInfo } from '../server/buildInfo.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { AccountConfig } from './config.js';
import { type Store } from './store.js';
import { createAuth, initializeAuth, type Auth } from './provider.js';
import { installPortal } from './portal.js';
import { digest } from './crypto.js';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_SKEW_SECONDS,
  AccessTokenFormat,
  Slots,
  TokenAdmission,
} from './token-admission.js';
import { log } from '../util/logger.js';
import { IpRateLimiter, bucketKey, clientIp } from '../server/ipRateLimiter.js';
import { originAllowed, bearerToken, MAX_REQUEST_BODY_BYTES } from '../server/http.js';
import { ACCOUNT_MCP_PATH, PUBLIC_MCP_PATH } from './paths.js';
import { DOCS_PATH, docsHandler } from './docs.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const CROSS_ORIGIN_PATHS =
  /^\/(?:mcp(?:\/account)?|\.well-known\/(?:oauth-protected-resource|oauth-authorization-server|openid-configuration)(?:\/[\w-]+)*|api\/auth\/(?:oauth2\/(?:register|token|revoke)|\.well-known\/(?:oauth-authorization-server|openid-configuration)))$/;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '600',
};
// Newer MCP clients add per-request headers (Mcp-Method, Mcp-Name, Mcp-Param-*), so preflights
// echo what was asked for; no credentials are allowed, so this grants nothing beyond the bearer.
const CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID';

/** Longest a token or revoke request waits for a lock connection, and then for the lock. */
const LOCK_WAIT_MS = 10_000;
/** Most /mcp/account token checks in flight per address bucket. */
const MAX_TOKEN_CHECKS_IN_FLIGHT = 256;
/** Per-IP flood allowance (a minute) for bearer token checks. */
const MCP_FLOOD_PER_MINUTE = 6000;
/** Token and revoke requests per address: 20 each second, bursts of 600 (Better Auth's own limit is 1200 a minute). */
const TOKEN_REQUEST_RPS = 20;
const TOKEN_REQUEST_BURST = 600;
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** What a /oauth2/token or /oauth2/revoke body asks to lock on, as Better Auth will read it. */
export type LockTarget = { token: string } | { code: string } | { ambiguous: true } | undefined;
/**
 * Reads the body with the runtime parser Better Auth itself uses (`Request.formData()`, so quirks
 * such as a leading '?' or a BOM are whatever this Node does) and names what the operation it
 * will run is about: revoke acts on `token`; a refresh grant on `refresh_token`; a code exchange
 * on `code`. Fields that operation ignores never choose the lock. A repeated `grant_type` (after
 * trimming, as Better Auth trims before dispatching) or chosen field with differing values is
 * ambiguous, and so is a body the parser rejects; the caller answers 400 for both. Anything else
 * (another media type, client_credentials, a missing or unknown grant, an empty value) is refused
 * or changes nothing downstream, so it takes no lock.
 */
export async function lockTarget(path: string, contentType: string | undefined, body: Buffer | undefined): Promise<LockTarget> {
  if ((contentType ?? '').toLowerCase().split(';')[0]!.trim() !== FORM_MEDIA_TYPE || !body) return undefined;
  let form: FormData;
  try {
    form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType! }, body: new Uint8Array(body) }).formData();
  } catch { return { ambiguous: true }; }
  // The last value is what Better Auth uses; differing repeats are refused rather than guessed at.
  const single = (name: string, trim = false) => {
    const values = form.getAll(name).map(v => (typeof v === 'string' && trim ? v.trim() : v));
    if (new Set(values).size > 1) return null;
    const last = values.at(-1);
    return typeof last === 'string' ? last : undefined;
  };
  let name: 'token' | 'refresh_token' | 'code';
  if (path === '/oauth2/revoke') name = 'token';
  else {
    const raw = single('grant_type', true);
    if (raw === null) return { ambiguous: true };
    const grant = raw?.trim();
    if (grant === 'refresh_token') name = 'refresh_token';
    else if (grant === 'authorization_code') name = 'code';
    else return undefined;
  }
  let value = single(name);
  if (value === null) return { ambiguous: true };
  // Revoke accepts the token with its authorization scheme ("Bearer R") and strips it.
  if (name === 'token' && value) value = stripAccessTokenAuthorizationScheme(value);
  if (!value) return undefined;
  return name === 'code' ? { code: value } : { token: value };
}
/** pg_advisory_xact_lock takes a signed 64-bit key; keys are `user:<id>`, `code:<code>` or `token:<digest>`. */
export const advisoryId = (key: string) => BigInt.asIntN(64, BigInt(`0x${digest(key).slice(0, 16)}`)).toString();
/** PostgreSQL's lock_not_available (lock_timeout), or the pool's connection wait running out. */
export const isLockBusy = (error: unknown) =>
  (error as { code?: string } | null)?.code === '55P03' ||
  /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(String((error as Error | null)?.message));

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Redirect URIs in a registration body; malformed JSON is left for Better Auth to reject. */
function registeredRedirects(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))?.redirect_uris ?? [];
  } catch {
    return [];
  }
}
/** Fields of a POST body, whether form-encoded or JSON (either may reach Better Auth). */
function jsonOrForm(body: Buffer): { get(name: string): string | null } {
  const text = body.toString('utf8').trim();
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      return { get: name => (typeof o[name] === 'string' ? o[name] as string : o[name] === undefined ? null : String(o[name])) };
    } catch { return { get: () => 'invalid' }; }
  }
  return new URLSearchParams(text);
}
/** The columns of a Better Auth `oauthAccessToken` row that bearer checks read. */
type AccessTokenRow = {
  userId?: string | null;
  clientId: string;
  revoked?: boolean | Date | null;
  expiresAt: Date | string;
  resources?: string[] | null;
  scopes?: string[] | string | null;
};

/** Client-side routes of the portal (web/src/main.tsx), served as index.html. */
const PORTAL_ROUTES = ['/', '/sign-in', '/connect', '/consent', '/account', '/error'];
/** Portal routes with their own prerendered page in dist/web (web/vite.config.ts). */
const PRERENDERED_ROUTES: Record<string, string> = { '/privacy-policy': 'privacy-policy.html', '/terms': 'terms.html' };
const PORTAL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** A top-level page load in a browser (not fetch, not an API client). */
function isNavigation(req: express.Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const mode = req.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return req.accepts(['json', 'html']) === 'html';
}

const TOO_MANY_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Too many requests · Patents &amp; Trademarks MCP</title></head>
<body><main><h1>Too many requests</h1><p>This address sent too many requests. Wait a minute, then <a href="/">try again</a>.</p></main></body>
</html>
`;

/** MCP's rule for redirect URIs: HTTPS, or plain HTTP only to this computer. */
export function allowedRedirect(value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)));
  } catch {
    return false;
  }
}

export async function createAccountApp(
  config: AccountConfig,
  store: Store,
  deps: CatalogDeps,
  fetcher: typeof fetch = fetch,
  /** Catalog for the anonymous endpoint (see publicDependencies): documentation tools only, no subject, no USPTO keys. */
  publicDeps: CatalogDeps,
  /** Test seams: a shorter lock wait, a smaller token-request budget or in-flight caps, the clock token admission reads, and what `/health` reports as running. */
  tuning: { lockWaitMs?: number; tokenRequestLimit?: { rps: number; burst: number }; maxTokenChecksInFlight?: number; now?: () => number; buildInfo?: BuildInfo } = {},
): Promise<{ app: express.Express; auth: Auth; mcp: ReturnType<typeof createMcpHandler>; close: () => Promise<void> }> {
  const buildInfo = tuning.buildInfo ?? readBuildInfo();
  const app = express();
  app.disable('x-powered-by');
  // Railway terminates TLS at one trusted proxy hop.
  if (config.production) app.set('trust proxy', 1);
  // With `trust proxy` 1, req.ip is the rightmost X-Forwarded-For entry. Railway rebuilds that
  // header as "<client>, <edge>", so req.ip is its edge, shared by many users. The header the
  // proxy overwrites with the client address (Railway: x-real-ip) is used instead when set.
  const ipOf = (req: express.Request) => config.clientIpHeader ? clientIp(req, config.clientIpHeader) : req.ip;
  // What every per-address limit counts by: an IPv6 /64 is one client, an IPv4-mapped address its IPv4.
  const limitKey = (req: express.Request) => bucketKey(ipOf(req) ?? 'unknown');
  // One clock for the issue time written into access tokens and the admission deadline read from them.
  const now = tuning.now ?? Date.now;
  const auth = createAuth(config, store, now);
  await initializeAuth(auth, config, store);
  // Each waiting token request holds a connection (idle in transaction), so size this for
  // concurrent token requests; a bounded wait keeps one stuck request from holding them all.
  const lockWaitMs = tuning.lockWaitMs ?? LOCK_WAIT_MS;
  const locks = new Pool({ ...store.pool.options, max: config.authLockPoolSize ?? 10, connectionTimeoutMillis: lockWaitMs });
  locks.on('error', () => log.error('account.auth_lock_connection_error'));
  /**
   * The advisory lock for what `lockTarget` found: the owner of a presented refresh or access
   * token, else the presented code or token itself (an unknown token changes nothing, and a code
   * is single-use). Tokens are stored as digests of their value. Undefined when there is nothing
   * to serialize, so such requests never queue behind each other on a shared key.
   */
  const tokenLockId = async (target: LockTarget) => {
    let key: string;
    if (target && 'code' in target) key = `code:${target.code}`;
    else if (target && 'token' in target) {
      const { adapter } = await auth.$context;
      const where = [{ field: 'token', value: digest(target.token) }];
      const row = await adapter.findOne<{ userId?: string }>({ model: 'oauthRefreshToken', where })
        ?? await adapter.findOne<{ userId?: string }>({ model: 'oauthAccessToken', where });
      key = row?.userId ? `user:${row.userId}` : `token:${digest(target.token)}`;
    } else return undefined;
    return advisoryId(key);
  };
  // Looking up the presented token costs database queries before any lock, and these routes skip
  // the page limiter, so each address gets a bounded in-memory budget.
  const tokenRequests = new IpRateLimiter(tuning.tokenRequestLimit?.rps ?? TOKEN_REQUEST_RPS, tuning.tokenRequestLimit?.burst ?? TOKEN_REQUEST_BURST);
  const mcp = createMcpHandler(
    ctx => buildMcpServer(deps, { subject: ctx.authInfo?.extra?.userId as string | undefined }),
    { legacy: 'stateless', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BODY_BYTES, onerror: () => log.warn('account.mcp_handler_error') },
  );
  // Anonymous endpoint: the same tools with no subject. No token is read or required.
  const publicMcp = createMcpHandler(
    () => buildMcpServer(publicDeps, {}),
    { legacy: 'stateless', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BODY_BYTES, onerror: () => log.warn('account.public_mcp_handler_error') },
  );
  const resource = `${config.origin}${ACCOUNT_MCP_PATH}`;
  const foreignOrigin = (req: express.Request) =>
    !!req.headers.origin && req.headers.origin !== config.origin;
  const metadataUrl = `${config.origin}/.well-known/oauth-protected-resource${ACCOUNT_MCP_PATH}`;
  const originHost = new URL(config.origin).host;
  app.use((req, res, next) => {
    // Hashed bundles under /assets set their own immutable Cache-Control; serve-static leaves an
    // existing header alone, so no-store here would defeat it.
    if (!req.path.startsWith('/assets/')) res.set('Cache-Control', 'no-store');
    res.set({
      'Referrer-Policy': 'strict-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path !== '/health' && req.headers.host !== originHost)
      return res.status(421).send('Invalid host');
    // MCP clients, including browser-based ones and hosted connectors such as Claude, call
    // discovery, registration, token and /mcp from other origins. These use bearer tokens or
    // client credentials, never cookies, and the Host check above prevents DNS rebinding.
    if (CROSS_ORIGIN_PATHS.test(req.path)) {
      res.set(CORS_HEADERS);
      if (req.method === 'OPTIONS')
        return res
          .status(204)
          .set({
            'Access-Control-Allow-Headers':
              req.headers['access-control-request-headers']?.slice(0, 1024) || CORS_ALLOW_HEADERS,
            Vary: 'Access-Control-Request-Headers',
          })
          .end();
      return next();
    }
    // Everything else is a cookie-authenticated browser surface and stays same-origin.
    if (foreignOrigin(req)) {
      log.warn('account.origin_rejected');
      return res.status(403).send('Invalid origin');
    }
    next();
  });
  app.get('/health', async (_req, res) => {
    try {
      await store.pool.query('SELECT 1');
      res.json({
        status: 'ok',
        protocolVersion: MCP_PROTOCOL_VERSION, sandbox: deps.sandbox.kind,
        ...buildInfo,
      });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  const webRoot = fileURLToPath(new URL('../../dist/web/', import.meta.url));
  app.use('/assets', express.static(resolve(webRoot, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  // The documentation site, when the image carries it (deploy/Dockerfile builds site/ into
  // docs-site/, a sibling of dist/ that the npm package does not ship). Static and public, so it
  // sits before the per-IP limiter like /assets, with its own CSP (see docs.ts).
  const docs = docsHandler(config.docsRoot ?? fileURLToPath(new URL('../../docs-site/', import.meta.url)));
  if (docs) {
    // `/docs` without the slash would serve the index at the wrong base; send it to `/docs/`.
    app.use(DOCS_PATH, (req, res, next) => {
      const [path = '', query] = req.originalUrl.split('?');
      if (path !== DOCS_PATH) return docs(req, res, next);
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.redirect(301, `${DOCS_PATH}/${query === undefined ? '' : `?${query}`}`);
    });
  }
  // Production reads each built page once; development rereads them so `pnpm dev:web` rebuilds show.
  const pages = new Map<string, string>();
  const loadPage = (file: string) => readFile(resolve(webRoot, file), 'utf8').catch(() => undefined);
  const sendPortal = async (res: express.Response, status = 200, file = 'index.html') => {
    const html = config.production ? (pages.get(file) ?? (await loadPage(file))) : await loadPage(file);
    if (!html) return res.status(503).send('The web interface is not built. Run pnpm build.');
    if (config.production) pages.set(file, html);
    res.status(status).set('Content-Security-Policy', PORTAL_CSP).type('html').send(html);
  };
  // The policy pages are prerendered at build time (web/prerender.ts), so their text is in the
  // HTML for clients that do not run JavaScript: crawlers, link checkers, directory reviewers.
  app.get(Object.keys(PRERENDERED_ROUTES), async (req, res) => {
    await sendPortal(res, 200, PRERENDERED_ROUTES[req.path.replace(/(?<=.)\/$/, '')]);
  });
  app.get(PORTAL_ROUTES, async (_req, res) => {
    await sendPortal(res);
  });
  const tooMany = (res: express.Response) => {
    res.status(429).set('Retry-After', '60');
    // A person in a browser gets a page; API clients get the short text they always did.
    if (isNavigation(res.req)) {
      return res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('html').send(TOO_MANY_PAGE);
    }
    return res.send('Too many requests');
  };
  app.use(async (req, res, next) => {
    // Hosted connectors (ChatGPT, Claude) send every user's OAuth and MCP traffic from a few
    // shared egress IPs, so those endpoints are limited elsewhere: Better Auth limits each OAuth
    // endpoint, and the signed-in MCP endpoint is limited per user after the token is checked
    // (see below). The anonymous endpoint has its own per-IP bucket (USPTO_IP_RPS/BURST) below.
    const platform =
      CROSS_ORIGIN_PATHS.test(req.path) &&
      (req.path !== ACCOUNT_MCP_PATH || !!bearerToken(req.headers.authorization));
    if (!platform && !(await store.allow(`http:${limitKey(req)}`, 600, 60))) return tooMany(res);
    next();
  });
  const mcpNode = toNodeHandler(mcp, {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: () => log.warn('account.mcp_http_error'),
  });
  const publicNode = toNodeHandler(publicMcp, {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: () => log.warn('account.public_mcp_http_error'),
  });
  // In memory per replica, like the base transport's limiter it mirrors.
  const publicLimiter = new IpRateLimiter(config.ipRps ?? 5, config.ipBurst ?? 20);
  // No sign-in here, so no USPTO key and no `execute`: documentation tools only (see
  // publicDependencies). A bearer token sent here is ignored; signed-in access is ACCOUNT_MCP_PATH.
  app.all(PUBLIC_MCP_PATH, async (req, res) => {
    if (!publicLimiter.allow(ipOf(req) ?? 'unknown')) return tooMany(res);
    // As in the base transport (MCP's Origin rule): with no token to check, a browser on another
    // site must not drive this endpoint. Non-browser clients send no Origin and pass. The signed-in
    // endpoint below accepts any Origin: hosted connectors (claude.ai, chatgpt.com) send theirs,
    // every request carries a bearer token (never a cookie), and the Host check above already
    // blocks DNS rebinding, which is what the Origin rule exists to prevent.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !originAllowed(origin, config.origin, config.allowedOrigins ?? []))
      return res.status(403).json({ error: 'origin_not_allowed' });
    await publicNode(req, res);
  });
  // Tokens issued by this server carry a MAC (token-admission.ts). Anything else is refused before any
  // database work or shared budget, so junk cannot touch the capacity of valid users on a shared address.
  const admission = new TokenAdmission(
    new AccessTokenFormat(config.authSecret, ACCESS_TOKEN_LIFETIME_SECONDS, ACCESS_TOKEN_SKEW_SECONDS, now),
    { now },
  );
  const tokenSlots = new Slots(tuning.maxTokenChecksInFlight ?? MAX_TOKEN_CHECKS_IN_FLIGHT);
  // No body parser: the SDK reads the body (capped at MAX_REQUEST_BODY_BYTES, as in the base
  // transport) only after the token checks below pass.
  app.all(ACCOUNT_MCP_PATH, async (req, res) => {
    const challenge = (status: number, error: string) =>
      res
        .status(status)
        .set(
          'WWW-Authenticate',
          `Bearer resource_metadata="${metadataUrl}", error="${error}", scope="uspto:read"`,
        )
        .json({ error });
    const authorization = req.headers.authorization;
    const value = authorization && authorization.length <= 4096 ? bearerToken(authorization) : undefined;
    if (!value?.startsWith(ACCESS_TOKEN_PREFIX)) return challenge(401, 'invalid_token');
    // Counted per address bucket: an IPv6 /64 is one client, however many addresses it uses.
    const ip = limitKey(req);
    const LIMITED = Symbol('limited');
    // Slot cap, flood guard, then the database check; undefined means proven invalid. Opaque tokens are
    // checked against their hashed database row on every request, so revocation, client disabling, user
    // deletion and loss of email verification apply immediately.
    const lookup = async () => {
      if (!tokenSlots.take(ip)) return LIMITED;
      try {
        // A flood guard sized for a connector's shared IP; the per-user limit below does the real work.
        if (!(await store.allow(`mcp-ip:${ip}`, MCP_FLOOD_PER_MINUTE, 60))) return LIMITED;
        const context = await auth.$context;
        const token = await context.adapter.findOne<AccessTokenRow>({
          model: 'oauthAccessToken',
          where: [{ field: 'token', value: digest(value) }],
        });
        if (
          !token?.userId ||
          token.revoked ||
          !(new Date(token.expiresAt).getTime() > now()) ||
          !(token.resources ?? []).includes(resource)
        )
          return undefined;
        const [client, user] = await Promise.all([
          context.adapter.findOne<{ disabled?: boolean | null }>({
            model: 'oauthClient',
            where: [{ field: 'clientId', value: token.clientId }],
          }),
          context.adapter.findOne<{ id: string; emailVerified?: boolean | null }>({
            model: 'user',
            where: [{ field: 'id', value: token.userId }],
          }),
        ]);
        if (!client || client.disabled || !user?.emailVerified) return undefined;
        return { token, user };
      } finally {
        tokenSlots.release(ip);
      }
    };
    const admitted = await admission.admit(value);
    if (admitted.kind === 'invalid') return challenge(401, 'invalid_token');
    if (admitted.kind === 'busy') return tooMany(res);
    let checked: Awaited<ReturnType<typeof lookup>>;
    try {
      checked = await lookup();
      // Only completed checks are remembered (rejections for 401s, successes as a routing hint); limits and errors are not.
      if (checked === undefined) admitted.reject();
      else if (checked !== LIMITED) admitted.validated();
    } finally {
      admitted.release();
    }
    if (checked === LIMITED) return tooMany(res);
    if (!checked) return challenge(401, 'invalid_token');
    const { token, user } = checked;
    if (!(token.scopes ?? []).includes('uspto:read')) return challenge(403, 'insufficient_scope');
    if (!(await store.allow(`mcp-user:${user.id}`, 600, 60))) return tooMany(res);
    const day = new Date().toISOString().slice(0, 10);
    if (!await store.allow(`mcp-day:${user.id}:${day}`, config.subjectDailyQuota ?? 10000, 86400)) return tooMany(res);
    Object.assign(req, {
      auth: {
        token: value,
        clientId: token.clientId,
        scopes: token.scopes,
        extra: { userId: user.id },
      },
    });
    await mcpNode(req, res);
  });
  // Clients look for authorization-server metadata in different places: RFC 8414 path
  // insertion for the /api/auth issuer (canonical, served by Better Auth), the issuer path with
  // /.well-known appended, or the origin root when a client skips protected-resource discovery.
  // Serve the same document at each. The openid-configuration URLs stay 404: this is not an
  // OpenID provider, and clients parse documents found there with the stricter OIDC schema.
  app.get(
    ['/.well-known/oauth-authorization-server', '/api/auth/.well-known/oauth-authorization-server'],
    async (_req, res) =>
      forwardResponse(
        await auth.handler(
          new Request(`${config.origin}/.well-known/oauth-authorization-server/api/auth`),
        ),
        res,
      ),
  );
  app.use(
    ['/api/auth', '/.well-known'],
    express.raw({ type: () => true, limit: '64kb' }),
    async (req, res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const ip = ipOf(req);
      if (ip) headers.set('x-forwarded-for', ip);
      else headers.delete('x-forwarded-for');
      const authUrl = new URL(req.originalUrl, config.origin);
      // WHATWG Request normalizes dot segments and backslashes. Reject aliases
      // before forwarding so Express guards and Better Auth see the same path.
      if (authUrl.origin !== config.origin || authUrl.pathname !== req.originalUrl.split('?')[0]) {
        return res.status(404).send('Not found');
      }
      let body = ['GET', 'HEAD'].includes(req.method) ? undefined : req.body;
      // MCP requires every redirect URI to be HTTPS or localhost. Check registrations here, and
      // authorization requests too, since Client ID Metadata Documents skip registration.
      const redirects =
        req.path === '/oauth2/register' && Buffer.isBuffer(body)
          ? registeredRedirects(body)
          : req.path === '/oauth2/authorize'
            ? [
                req.method === 'POST' && Buffer.isBuffer(body)
                  ? jsonOrForm(body).get('redirect_uri')
                  : authUrl.searchParams.get('redirect_uri'),
              ].filter(Boolean)
            : [];
      if (!Array.isArray(redirects) || !redirects.every(allowedRedirect))
        return res.status(400).json({
          error: req.path === '/oauth2/register' ? 'invalid_redirect_uri' : 'invalid_request',
          error_description: 'Redirect URIs must use HTTPS or a localhost address.',
        });
      // Desktop MCP clients register loopback redirects (http://127.0.0.1:<port>/callback, RFC 8252)
      // and often omit `application_type`, which OpenID DCR defaults to "web" (HTTPS only), so the
      // registration would fail. All-loopback-HTTP registrations are native apps: say so.
      if (req.path === '/oauth2/register' && Buffer.isBuffer(body) && redirects.length > 0 &&
          (redirects as string[]).every(u => new URL(u).protocol === 'http:')) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && parsed.application_type === undefined) {
            body = Buffer.from(JSON.stringify({ ...parsed, application_type: 'native' }));
          }
        } catch { /* malformed JSON: Better Auth rejects it */ }
      }
      // Clients that omit RFC 8707 `resource` (Gemini Enterprise may) would get tokens this
      // server cannot accept. It protects one resource, so default to it; the code keeps it.
      if (req.path === '/oauth2/authorize') {
        if (req.method === 'GET' && !authUrl.searchParams.get('resource'))
          authUrl.searchParams.set('resource', resource);
        if (
          req.method === 'POST' &&
          req.is('application/x-www-form-urlencoded') &&
          Buffer.isBuffer(body)
        ) {
          const form = new URLSearchParams(body.toString('utf8'));
          if (!form.get('resource')) form.set('resource', resource);
          body = Buffer.from(form.toString());
          headers.delete('content-length');
        }
      }
      const request = new Request(authUrl, {
        method: req.method,
        headers,
        body,
      });
      const execute = async () => {
        const response = await auth.handler(request);
        // Registration failures are otherwise invisible; log the outcome only, no request data.
        if (req.path === '/oauth2/register')
          log.info('client_registration', { status: response.status, crossOrigin: foreignOrigin(req) });
        return forwardResponse(response, res);
      };
      if (req.path !== '/oauth2/token' && req.path !== '/oauth2/revoke') return execute();
      // Serialize token-family rotation and invalidation across replicas. Better Auth's
      // current adapter performs those writes separately; overlapping requests must not
      // interleave. A family is every refresh token of one (client, user), so refresh and revoke
      // lock per user and a code exchange locks per code: unrelated users never queue together.
      // A code exchange can still overlap a family wipe for the same user; at worst that new
      // authorization is revoked and the user authorizes again.
      if (!tokenRequests.allow(limitKey(req))) return tooMany(res);
      const target = await lockTarget(req.path, req.get('content-type'), Buffer.isBuffer(body) ? body : undefined);
      if (target && 'ambiguous' in target)
        return res.status(400).json({ error: 'invalid_request', error_description: 'The request body is ambiguous or cannot be parsed.' });
      const lockId = await tokenLockId(target);
      if (lockId === undefined) return execute();
      // Too busy to take the lock in time: the client should retry, not see a server fault.
      const busy = () => res.status(503).set('Retry-After', '5').json({ error: 'temporarily_unavailable', error_description: 'Try again shortly.' });
      const lock = await locks.connect().catch((error: unknown) => {
        if (isLockBusy(error)) return undefined;
        throw error;
      });
      if (!lock) return busy();
      // A transaction-scoped lock is released by COMMIT or ROLLBACK, and a bounded wait keeps one
      // stuck request from holding every lock connection and queueing all users' token requests.
      let broken = false;
      let locked = false;
      try {
        await lock.query('BEGIN');
        await lock.query(`SET LOCAL lock_timeout = '${lockWaitMs}ms'`);
        await lock.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
        locked = true;
        await execute();
        await lock.query('COMMIT');
      } catch (error) {
        // A connection that cannot roll back may still hold the lock; discard it.
        await lock.query('ROLLBACK').catch(() => { broken = true; });
        if (!locked && isLockBusy(error)) return busy();
        throw error;
      } finally {
        lock.release(broken);
      }
    },
  );
  installPortal(app, config, store, auth, fetcher, ipOf);
  // Unknown paths: a person in a browser gets the portal's own not-found page (status 404);
  // API clients get the short text they always did.
  app.use(async (req, res) => {
    if (isNavigation(req)) return sendPortal(res, 404);
    res.status(404).send('Not found');
  });
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (
        error &&
        typeof error === 'object' &&
        'type' in error &&
        ['entity.too.large', 'parameters.too.many'].includes(String(error.type))
      ) {
        if (!res.headersSent) res.status(413).send('Request too large');
        return;
      }
      log.error('account.request_failed');
      if (!res.headersSent)
        res
          .status(500)
          .json({ error: 'Unable to complete this request. Please try again.' });
    },
  );
  return {
    app,
    auth,
    mcp,
    close: async () => {
      await mcp.close();
      await publicMcp.close();
      await locks.end();
    },
  };
}
export async function forwardResponse(response: Response, res: express.Response) {
  res.status(response.status);
  for (const [name, value] of response.headers)
    if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.send(Buffer.from(await response.arrayBuffer()));
}
