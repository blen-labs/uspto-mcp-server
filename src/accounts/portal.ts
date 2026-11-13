import express, { type Express, type Request, type Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { AccountConfig } from './config.js';
import { ACCOUNT_MCP_PATH, PUBLIC_MCP_PATH } from './paths.js';
import { personalOwner, isKeyKind, KEY_KINDS, type KeyKind, type Store } from './store.js';
import type { Auth } from './provider.js';
import { log } from '../util/logger.js';
import { gateFor } from './keyGates.js';
import { parseRetryAfter } from '../util/httpClient.js';

/**
 * Each key goes only to its own fixed upstream; no URL, owner or user ID comes from the form.
 * Only a 2xx proves the key: ODP answers 403 to a bad key, but TSDR answers 404 (and its
 * last-update endpoint answers 204 with no key at all), so TSDR is probed with a case that
 * exists and must return 200.
 */
const KEY_CHECKS: Record<KeyKind, { label: string; url: string; header: string }> = {
  odp: { label: 'USPTO Open Data Portal', url: 'https://api.uspto.gov/api/v1/patent/status-codes?offset=0&limit=1', header: 'X-API-KEY' },
  tsdr: { label: 'USPTO TSDR', url: 'https://tsdrapi.uspto.gov/ts/cd/casestatus/sn97123456/info', header: 'USPTO-API-KEY' },
};

export async function checkKey(kind: KeyKind, key: unknown, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const { label, url, header } = KEY_CHECKS[kind];
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{16,128}$/.test(key)) return `Enter your ${label} API key.`;
  // The check is a request with this key, so it waits its turn like any other use of the key.
  let release: (() => void) | undefined;
  const gate = gateFor(kind, key);
  try {
    release = await gate.acquire();
  } catch {
    return `${label} is busy with this key right now. Try again in a minute; your existing key was preserved.`;
  }
  try {
    const result = await fetcher(url, {
      headers: { [header]: key, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    // A 429 cools the credential down for everyone, from status and headers alone, before any
    // body handling that could fail: the same policy as HttpClient (>= 5 s, or Retry-After).
    if (result.status === 429) {
      gate.pause(Math.max(5000, parseRetryAfter(result.headers.get('retry-after') ?? undefined) ?? 0));
    }
    // Key validation needs status only. Never log, echo, or persist the upstream body.
    try { await result.body?.cancel(); } catch { /* nothing to release */ }
    if (result.status === 401 || result.status === 403 || (kind === 'tsdr' && result.status === 404)) return `${label} rejected this key. Your existing key was preserved.`;
    if (!result.ok) {
      // Any other status is a problem with the check itself, not the key: record it (status only).
      log.warn('account.key_check_failed', { kind, status: result.status });
      return result.status === 429
        ? `${label} is rate limiting this key right now. Try again in a minute; your existing key was preserved.`
        : `The ${label} connection check failed. Your existing key was preserved.`;
    }
  } catch {
    return `The ${label} connection check failed. Your existing key was preserved.`;
  } finally {
    release?.();
  }
}

/** Keys from a form body, by kind: `apiKey` is the ODP key, `tsdrApiKey` the TSDR key. */
const KEY_FIELDS: Record<KeyKind, string> = { odp: 'apiKey', tsdr: 'tsdrApiKey' };

export function installPortal(
  app: Express, config: AccountConfig, store: Store, auth: Auth, fetcher: typeof fetch,
  ipOf: (req: Request) => string | undefined,
) {
  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET' && (req.headers.origin !== config.origin || !req.is('application/json'))) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    next();
  });
  async function verified(req: Request) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user.emailVerified ? session : undefined;
  }
  async function validQuery(value: unknown) {
    return typeof value === 'string' && value.length < 16384 &&
      await verifyOAuthQueryParams(value, config.authSecret) ? value : undefined;
  }
  const error = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
  async function account(user: { id: string; email: string }) {
    const keys = await store.keyStatus(personalOwner(user.id));
    return { email: user.email, keys, mcpUrl: `${config.origin}${ACCOUNT_MCP_PATH}` };
  }
  /** Check, then save, every key present in `body`. Nothing is saved unless all checks pass. */
  async function saveKeys(owner: string, actor: string, body: Record<string, unknown>, res: Response): Promise<boolean> {
    const present = KEY_KINDS.filter(kind => body[KEY_FIELDS[kind]] !== undefined && body[KEY_FIELDS[kind]] !== '');
    if (!present.length) return true;
    if (!await store.allow(`key:${owner}`, 5, 60)) { error(res, 429, 'Too many key checks. Try again in one minute.'); return false; }
    for (const kind of present) {
      const problem = await checkKey(kind, body[KEY_FIELDS[kind]], fetcher);
      if (problem) { error(res, 400, problem); return false; }
    }
    for (const kind of present) await store.saveKey(owner, kind, body[KEY_FIELDS[kind]] as string, actor);
    return true;
  }
  /** What the Connect and Consent pages show, or undefined when the signed query lacks the client or its redirect. */
  async function connection(query: string) {
    const params = new URLSearchParams(query);
    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    if (!clientId || !redirectUri || !URL.canParse(redirectUri)) return undefined;
    const client = await (await auth.$context).adapter.findOne<{ name?: string }>({
      model: 'oauthClient', where: [{ field: 'clientId', value: clientId }],
    });
    const redirect = new URL(redirectUri);
    return { client: client?.name || 'This application', destination: redirect.host,
      local: ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) };
  }
  const EXPIRED = 'This connection request expired. Start again from your AI assistant.';
  async function continueWith(req: Request, res: Response, path: string, body: object) {
    const headers = fromNodeHeaders(req.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    // Forward only the client address trusted by Express, not a caller's spoofed chain.
    const ip = ipOf(req);
    if (ip) headers.set('x-forwarded-for', ip);
    else headers.delete('x-forwarded-for');
    const response = await auth.handler(new globalThis.Request(`${config.origin}/api/auth${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    const result = await response.json().catch(() => ({})) as { url?: unknown; redirect_uri?: unknown };
    const url = response.status >= 300 && response.status < 400 ? response.headers.get('location') : result.url ?? result.redirect_uri;
    if (typeof url !== 'string' || response.status >= 400) return error(res, 400, 'Connection authorization failed.');
    res.json({ url: new URL(url, config.origin).toString() });
  }
  api.get('/config', (_req, res) => res.json({ google: true, email: false, mcpUrl: `${config.origin}${ACCOUNT_MCP_PATH}`, publicMcpUrl: `${config.origin}${PUBLIC_MCP_PATH}` }));
  api.get('/connect', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.query.oauth_query);
    const shown = query && await connection(query);
    if (!shown) return error(res, 400, EXPIRED);
    res.json({ ...shown, ...await account(logged.user) });
  });
  api.post('/connect', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.body?.oauth_query);
    if (!query || !['continue', 'deny'].includes(req.body?.decision) ||
        Object.keys(req.body ?? {}).some(key => !['oauth_query', 'decision', 'apiKey', 'tsdrApiKey'].includes(key))) {
      return error(res, 400, 'Connection authorization failed.');
    }
    if (req.body.decision === 'deny') {
      await store.clearConnectionStep(logged.session.id);
      return continueWith(req, res, '/oauth2/consent', { oauth_query: query, accept: false });
    }
    if (!await saveKeys(personalOwner(logged.user.id), logged.user.id, req.body, res)) return;
    await store.markConnectionReady(logged.session.id, logged.user.id);
    try {
      return await continueWith(req, res, '/oauth2/continue', { oauth_query: query, postLogin: true });
    } finally {
      // Better Auth signs the completed step into the consent query. New flows
      // must visit Connect again; keep no reusable browser-wide selection.
      await store.clearConnectionStep(logged.session.id);
    }
  });
  api.get('/account', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    res.json(await account(logged.user));
  });
  api.post('/keys', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const body = req.body ?? {};
    if (Object.keys(body).some(key => !['apiKey', 'tsdrApiKey'].includes(key)) ||
        !KEY_KINDS.some(kind => typeof body[KEY_FIELDS[kind]] === 'string' && body[KEY_FIELDS[kind]])) {
      return error(res, 400, 'Send apiKey (Open Data Portal) and/or tsdrApiKey (TSDR).');
    }
    if (!await saveKeys(personalOwner(logged.user.id), logged.user.id, body, res)) return;
    res.json({ saved: true });
  });
  api.post('/keys/delete', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const body = req.body ?? {};
    if (Object.keys(body).some(key => key !== 'kind') || !isKeyKind(body.kind)) return error(res, 400, "Send kind: 'odp' or 'tsdr'.");
    await store.deleteKey(personalOwner(logged.user.id), body.kind, logged.user.id);
    res.json({ deleted: true });
  });
  api.get('/consent', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.query.oauth_query);
    const shown = query && await connection(query);
    if (!shown) return error(res, 400, EXPIRED);
    const keys = await store.keyStatus(personalOwner(logged.user.id));
    res.json({ ...shown, email: logged.user.email, keys: { odp: keys.odp.connected, tsdr: keys.tsdr.connected } });
  });
  api.post('/consent', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.body?.oauth_query);
    if (!query || typeof req.body?.accept !== 'boolean') return error(res, 400, 'Connection authorization failed.');
    return continueWith(req, res, '/oauth2/consent', { oauth_query: query, accept: req.body.accept });
  });
  app.use('/api/portal', api);
}
