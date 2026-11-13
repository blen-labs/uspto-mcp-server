import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { testUtils } from 'better-auth/plugins';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { MockAgent } from 'undici';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Keyring, randomToken, digest } from '../src/accounts/crypto.js';
import { Store, personalOwner, type KeyKind } from '../src/accounts/store.js';
import { createAccountApp, allowedRedirect } from '../src/accounts/app.js';
import { accountDependencies, publicDependencies } from '../src/accounts/runtime.js';
import { loadAccountConfig, type AccountConfig } from '../src/accounts/config.js';
import { checkKey } from '../src/accounts/portal.js';
import { gateFor, gateHandle, gateCount } from '../src/accounts/keyGates.js';
import { LIMIT_DEFAULTS } from '../src/supervisor/index.js';
import { buildSupervisor, type SupervisorConfig } from '../src/supervisor/index.js';
import { supervisorCfg } from './helpers.js';

it('encrypts keys with random nonces and binds ciphertext to its account and purpose', () => {
  const keys = { old: randomBytes(32), next: randomBytes(32) };
  const ring = new Keyring('old', keys);
  const sealed = ring.seal('secret', 'uspto-odp:user:a');
  expect(ring.seal('secret', 'uspto-odp:user:a')).not.toEqual(sealed);
  expect(JSON.stringify(sealed)).not.toContain('secret');
  expect(ring.open(sealed, 'uspto-odp:user:a')).toBe('secret');
  expect(() => ring.open(sealed, 'uspto-odp:user:b')).toThrow();
  expect(() => ring.open(sealed, 'oauth:user:a')).toThrow();
  expect(() => ring.open({ ...sealed, data: 'AAAA' }, 'uspto-odp:user:a')).toThrow();
  // A truncated (still valid-prefix) tag must not be accepted.
  const shortTag = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64');
  expect(() => ring.open({ ...sealed, tag: shortTag }, 'uspto-odp:user:a')).toThrow();
  expect(new Keyring('next', keys).open(sealed, 'uspto-odp:user:a')).toBe('secret');
});

it('rejects unsafe origins, missing secrets, and unsafe OAuth redirects', () => {
  expect(() => loadAccountConfig({})).toThrow();
  const invalid = { USPTO_PUBLIC_ORIGIN: 'https://example.com', BETTER_AUTH_SECRET: 's'.repeat(32), ENCRYPTION_KEYS_JSON: '{"key":"sensitive-key-material"' };
  try { loadAccountConfig(invalid); throw new Error('Expected invalid JSON to fail'); }
  catch (error) { expect(String(error)).not.toContain('sensitive-key-material'); expect(String(error)).toContain('must be valid JSON'); }
  for (const url of ['http://evil.example/cb', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/#fragment']) expect(allowedRedirect(url)).toBe(false);
  expect(allowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  expect(allowedRedirect('http://127.0.0.1:1234/cb')).toBe(true);
});

it('validates each key only at its own USPTO API and preserves safe errors', async () => {
  const key = 'k'.repeat(32);
  expect(await checkKey('odp', 'bad')).toMatch(/Enter your USPTO Open Data Portal API key/);
  expect(await checkKey('odp', key, async (url, init) => {
    expect(String(url)).toBe('https://api.uspto.gov/api/v1/patent/status-codes?offset=0&limit=1');
    expect(new Headers(init?.headers).get('X-API-KEY')).toBe(key);
    expect(init?.redirect).toBe('error');
    return new Response(null, { status: 200 });
  })).toBeUndefined();
  expect(await checkKey('tsdr', key, async (url, init) => {
    expect(String(url)).toBe('https://tsdrapi.uspto.gov/ts/cd/casestatus/sn97123456/info');
    expect(new Headers(init?.headers).get('USPTO-API-KEY')).toBe(key);
    return new Response(null, { status: 200 });
  })).toBeUndefined();
  // TSDR answers a bad key with 404, and a 2xx is the only proof for either API.
  expect(await checkKey('tsdr', key, async () => new Response(null, { status: 404 }))).toMatch(/TSDR rejected this key/);
  expect(await checkKey('odp', key, async () => new Response(null, { status: 404 }))).toMatch(/connection check failed/);
  expect(await checkKey('odp', key, async () => new Response(key, { status: 403 }))).toMatch(/rejected this key.*preserved/);
  expect(await checkKey('tsdr', key, async () => new Response(key, { status: 401 }))).toMatch(/TSDR rejected this key/);
  expect(await checkKey('odp', key, async () => new Response(key, { status: 500 }))).toMatch(/connection check failed.*preserved/);
  expect(await checkKey('odp', key, async () => new Response(key, { status: 429 }))).toMatch(/rate limiting/);
  expect(await checkKey('odp', key, async () => { throw new Error(key); })).not.toContain(key);
});

it('never serves a shared key anonymously: documentation tools only, each source points to sign-in', () => {
  const meta = [{ name: 'odp', label: 'USPTO Open Data Portal', enabled: true }, { name: 'tsdr', label: 'USPTO TSDR', enabled: false }];
  const keyed = { sdk: { methods: { odp: { 'patents.search': () => 1 } }, meta, clients: { odp: {} }, registeredNames: ['odp', 'tsdr'], version: () => '0' } } as unknown as Parameters<typeof publicDependencies>[0];
  const out = publicDependencies(keyed, 'https://x.example');
  expect(out.tools).toEqual(['search_api', 'describe_schema']);
  expect(out.sdk.methods.odp).toBeUndefined();
  expect(out.sdk.clients.odp).toBeUndefined();
  for (const m of out.sdk.meta) expect(m).toMatchObject({ enabled: false, disabledReason: expect.stringContaining('https://x.example/mcp/account') });
});

it('admits one request per credential, whichever account or key check uses it', async () => {
  const k = 'shared-credential-0123456789';
  const g = gateFor('odp', k, LIMIT_DEFAULTS.odp);
  expect(gateFor('odp', k, LIMIT_DEFAULTS.odp)).toBe(g); // same key saved by two owners
  expect(gateFor('tsdr', k, LIMIT_DEFAULTS.tsdr)).not.toBe(g);
  expect(gateFor('odp', k + 'x', LIMIT_DEFAULTS.odp)).not.toBe(g);
  // A key check waits for the key's in-flight request instead of running beside it.
  const release = await g.acquire();
  let checked = false;
  const check = checkKey('odp', k, async () => { checked = true; return new Response(null, { status: 200 }); });
  await new Promise(r => setTimeout(r, 50));
  expect(checked).toBe(false);
  release();
  expect(await check).toBeUndefined();
  expect(checked).toBe(true);
});

it('a rate-limited key check cools the credential down by the same rules as other calls', async () => {
  const k = 'cooldown-credential-0123456789';
  const inAnHour = new Date(Date.now() + 3600_000).toUTCString();
  expect(await checkKey('odp', k, async () => new Response(null, { status: 429, headers: { 'retry-after': inAnHour } }))).toMatch(/rate limiting/);
  expect(gateFor('odp', k, LIMIT_DEFAULTS.odp).pausedForMs()).toBeGreaterThan(3_000_000);
  const k2 = 'cooldown-credential-abcdefghij';
  const failingBody = new Response(new ReadableStream({ pull() { throw new Error('cancel fails'); } }), { status: 429 });
  Object.defineProperty(failingBody, 'body', { value: { cancel: async () => { throw new Error('cancel fails'); } } });
  await checkKey('odp', k2, async () => failingBody);
  expect(gateFor('odp', k2, LIMIT_DEFAULTS.odp).pausedForMs()).toBeGreaterThanOrEqual(4000);
});

it('a cached client keeps sharing admission after the registry retires idle gates', async () => {
  const k = 'retired-credential-0123456789';
  const handle = gateHandle('odp', k, LIMIT_DEFAULTS.odp); // what a cached account client holds
  gateFor('odp', k, LIMIT_DEFAULTS.odp);
  const before = gateCount();
  for (let i = 0; i < 1100; i++) gateFor('odp', `filler-${i}-0123456789abcdef`, LIMIT_DEFAULTS.odp); // crosses the sweep threshold
  expect(gateCount()).toBeLessThan(before + 1100); // idle gates, including this credential's, were retired
  const held = await handle.acquire();
  let second = false;
  const waiting = gateFor('odp', k, LIMIT_DEFAULTS.odp).acquire().then(r => { second = true; return r; });
  await new Promise(r => setTimeout(r, 50));
  expect(second).toBe(false); // one request in flight for the credential, not two
  held();
  (await waiting)();
});

it('never lets shared keys reach the signed-in catalog', async () => {
  const cfg: SupervisorConfig = supervisorCfg({ odpApiKey: 'shared-operator-odp-key', tsdrApiKey: 'shared-operator-tsdr-key', sandbox: 'deno', cacheTtlMs: 60000, cacheMaxItems: 10 });
  const deps = await buildSupervisor(cfg);
  expect(deps.sdk.methods.odp).toBeDefined();
  expect(deps.sdk.methods.tsdr).toBeDefined();
  // A user with no saved keys: each source must ask for one, never fall back to the shared key.
  const noKey = { getKey: async () => undefined } as unknown as Store;
  const account = accountDependencies(deps, cfg, noKey);
  expect(account.sdk.methods.odp).toBeUndefined();
  expect(account.sdk.clients.tsdr).toBeUndefined();
  const sdk = await account.sdkForSubject!('user-1');
  await expect(sdk.methods.odp!['patents.search']!('x')).rejects.toMatchObject({ name: 'SourceUnavailable' });
  await expect(sdk.methods.tsdr!.status!('sn97123456')).rejects.toMatchObject({ name: 'SourceUnavailable', message: expect.stringContaining('TSDR') });
  expect(Object.keys(sdk.methods.odp!).sort()).toEqual(Object.keys(deps.sdk.methods.odp!).sort());
  expect(publicDependencies(deps, 'https://x.example').sdk.methods.odp).toBeUndefined();
});

/** Counts key reads, to check that executions read only the keys of the sources they call. */
class CountingStore extends Store {
  keyReads = 0;
  reads: KeyKind[] = [];
  override async getKey(owner: string, kind: KeyKind) {
    this.keyReads++;
    this.reads.push(kind);
    return super.getKey(owner, kind);
  }
}

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)('account HTTP / OAuth with PostgreSQL', () => {
  let pool: Pool, store: CountingStore, server: Server, config: AccountConfig;
  let service: Awaited<ReturnType<typeof createAccountApp>>;
  let helper: ReturnType<ReturnType<typeof testUtils>['init']>['context']['test'];
  let alice: any, bob: any, browser: typeof fetch, other: typeof fetch;
  let validationStatus = 200;
  const schema = `uspto_test_${randomBytes(8).toString('hex')}`;
  const key = 'a'.repeat(32), key2 = 'b'.repeat(32), tsdrKey = 't'.repeat(32);
  const ODP = 'https://api.uspto.gov', TSDR = 'https://tsdrapi.uspto.gov';
  const META = '/api/v1/patent/applications/17248024/meta-data';
  let mock: MockAgent;
  // Operator overrides and shared keys must never apply to signed-in calls.
  const cfg: SupervisorConfig = supervisorCfg({
    odpBaseUrl: 'https://evil.example', odpApiKey: 'legacy-shared-key', tsdrBaseUrl: 'https://evil.example',
    sandbox: 'deno', cacheTtlMs: 60000, cacheMaxItems: 10,
  });
  const send = (client: typeof fetch, path: string, body: object, origin?: string) => client(`${config.origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: origin ?? config.origin }, body: JSON.stringify(body),
  });
  async function login(userId: string) {
    const logged = await helper.login({ userId });
    const jar = new CookieJar();
    for (const cookie of logged.cookies) await jar.setCookie(`${cookie.name}=${cookie.value}; Path=/`, config.origin);
    return fetchCookie(fetch, jar) as typeof fetch;
  }
  function signedQuery(url: string) {
    const params = new URL(url, config.origin).searchParams;
    const names = new Set(params.getAll('ba_param'));
    const out = new URLSearchParams();
    for (const [k, v] of params) if (k === 'sig' || k === 'ba_param' || names.has(k)) out.append(k, v);
    return out.toString();
  }
  async function register() {
    const response = await send(fetch, '/api/auth/oauth2/register', {
      client_name: 'Test assistant', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as any;
  }
  async function beginAuthorization(clientBrowser = browser) {
    const client = await register();
    const verifier = randomToken();
    const state = randomToken();
    const query = new URLSearchParams({
      client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      scope: 'uspto:read offline_access', resource: `${config.origin}/mcp/account`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
    });
    let response = await clientBrowser(`${config.origin}/api/auth/oauth2/authorize?${query}`, {
      headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
    });
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result = await response.json() as any;
      expect(result.redirect, JSON.stringify(result)).toBe(true);
      response = await clientBrowser(new URL(result.url, config.origin));
    }
    expect(new URL(response.url).pathname).toBe('/connect');
    return { client, verifier, state, oauth_query: signedQuery(response.url) };
  }
  async function authorize(clientBrowser = browser, accept = true) {
    const { client, verifier, state, oauth_query: connectQuery } = await beginAuthorization(clientBrowser);
    const connect = await send(clientBrowser, '/api/portal/connect', { oauth_query: connectQuery, decision: 'continue' });
    expect(connect.status, await connect.clone().text()).toBe(200);
    const consentUrl = new URL((await connect.json() as any).url);
    expect(consentUrl.pathname).toBe('/consent');
    const oauth_query = signedQuery(consentUrl.toString());
    const info = await clientBrowser(`${config.origin}/api/portal/consent?oauth_query=${encodeURIComponent(oauth_query)}`);
    expect(info.status).toBe(200);
    const consent = await send(clientBrowser, '/api/portal/consent', { oauth_query, accept });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const callback = new URL((await consent.json() as any).url);
    expect(callback.origin).toBe('https://client.example');
    expect(callback.searchParams.get('state')).toBe(state);
    return { client, verifier, code: callback.searchParams.get('code'), callback };
  }
  const exchange = (clientId: string, body: Record<string, string>) => fetch(`${config.origin}/api/auth/oauth2/token`, {
    method: 'POST', body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  async function token(clientBrowser = browser) {
    const a = await authorize(clientBrowser);
    const response = await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: a.verifier, redirect_uri: a.client.redirect_uris[0] });
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...await response.json() as any, clientId: a.client.client_id };
  }
  async function mcp(token: string | undefined, code = 'return 42;', path = '/mcp/account') {
    const response = await fetch(`${config.origin}${path}`, {
      method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'execute', 'Mcp-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { code }, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'auth-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    });
    return { status: response.status, body: await response.text() };
  }
  beforeAll(async () => {
    const admin = new Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
    pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
    store = new CountingStore(pool, new Keyring('v1', { v1: randomBytes(32) }));
    await store.initialize();
    server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config = { origin: `http://127.0.0.1:${(server.address() as any).port}`, production: false,
      databaseUrl: database!, authSecret: randomToken(), googleClientId: 'fixture-google', googleClientSecret: 'fixture-secret', keyring: new Keyring('v1', { v1: randomBytes(32) }),
      clientIpHeader: 'x-real-ip' };
    const deps = await buildSupervisor(cfg);
    expect(await deps.sandbox.available(), 'Deno is required for account integration tests').toBe(true);
    // Upstream USPTO calls go through an injected MockAgent, never the global dispatcher.
    mock = new MockAgent(); mock.disableNetConnect();
    // The anonymous endpoint gets no shared key here, so USPTO calls there must point to sign-in.
    const publicDeps = publicDependencies(await buildSupervisor(cfg), config.origin); // cfg HAS a shared key: it must stay unused
    service = await createAccountApp(config, store, accountDependencies(deps, cfg, store, mock), async () => new Response(null, { status: validationStatus }), publicDeps);
    server.on('request', service.app);
    helper = testUtils().init((await service.auth.$context) as unknown as Parameters<ReturnType<typeof testUtils>['init']>[0]).context.test;
    alice = await helper.saveUser(helper.createUser({ email: 'alice@example.test', emailVerified: true }));
    bob = await helper.saveUser(helper.createUser({ email: 'bob@example.test', emailVerified: true }));
    browser = await login(alice.id); other = await login(bob.id);
  });
  afterAll(async () => {
    await mock?.close(); await service?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
  });
  it('registers desktop clients with loopback HTTP redirects even without application_type', async () => {
    for (const uri of ['http://127.0.0.1:33418/callback', 'http://localhost:33418/callback', 'http://[::1]:33418/callback']) {
      const r = await send(fetch, '/api/auth/oauth2/register', {
        client_name: 'Desktop client', redirect_uris: [uri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      });
      expect(r.status, `${uri}: ${await r.clone().text()}`).toBe(201);
    }
    // Non-loopback HTTP stays refused.
    expect((await send(fetch, '/api/auth/oauth2/register', { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
  });
  it('discovers OAuth, challenges anonymous callers, and offers Google sign-in', async () => {
    const metadata = await fetch(`${config.origin}/.well-known/oauth-protected-resource/mcp/account`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: `${config.origin}/mcp/account` });
    const challenge = await fetch(`${config.origin}/mcp/account`, { method: 'POST' });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(`resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp/account"`);
    const discovery = await fetch(`${config.origin}/.well-known/oauth-authorization-server`);
    expect(await discovery.json()).toMatchObject({ authorization_endpoint: `${config.origin}/api/auth/oauth2/authorize` });
    expect((await mcp('invalid')).status).toBe(401);
    const google = await send(fetch, '/api/auth/sign-in/social', { provider: 'google', callbackURL: '/account' });
    expect(google.status, await google.clone().text()).toBe(200);
    expect(new URL((await google.json() as any).url).hostname).toBe('accounts.google.com');
  });
  // Needs the Vite bundle: `pnpm build` (CI builds before testing). Skipped, not failed, without it.
  const webBuilt = existsSync(new URL('../dist/web/index.html', import.meta.url));
  it.skipIf(!webBuilt)('serves the SAM.gov-style frontend and policies with same-origin assets (needs pnpm build)', async () => {
    for (const path of ['/', '/sign-in', '/account', '/connect', '/consent', '/privacy-policy', '/terms']) {
      const page = await fetch(`${config.origin}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      const html = await page.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
      expect(assets.length).toBeGreaterThanOrEqual(2);
      for (const asset of assets) {
        const response = await fetch(`${config.origin}${asset}`);
        expect(response.status).toBe(200);
        // Drain static bundles so Undici can close its pooled connections.
        await response.arrayBuffer();
      }
    }
    expect(await (await fetch(`${config.origin}/api/portal/config`)).json()).toMatchObject({ google: true, email: false });
  });
  it('validates the separate connection step, preserves saved keys on failure, and allows cancellation', async () => {
    const { oauth_query, state } = await beginAuthorization();
    const payload = { oauth_query, decision: 'continue' };
    expect((await send(fetch, '/api/portal/connect', payload)).status).toBe(401);
    expect((await send(browser, '/api/portal/connect', payload, 'https://evil.example')).status).toBe(403);
    expect((await send(browser, '/api/portal/connect', { ...payload, oauth_query: `${oauth_query}&client_id=attacker` })).status).toBe(400);
    expect((await send(browser, '/api/portal/connect', { ...payload, owner: personalOwner(bob.id) })).status).toBe(400);
    const info = await browser(`${config.origin}/api/portal/connect?oauth_query=${encodeURIComponent(oauth_query)}`);
    expect(await info.json()).toMatchObject({ email: alice.email, client: 'Test assistant', keys: { odp: { connected: false }, tsdr: { connected: false } } });
    expect((await send(browser, '/api/portal/connect', { ...payload, apiKey: key, tsdrApiKey: tsdrKey })).status).toBe(200);
    expect(await store.getKey(personalOwner(alice.id), 'odp')).toBe(key);
    expect(await store.getKey(personalOwner(alice.id), 'tsdr')).toBe(tsdrKey);
    validationStatus = 403;
    expect((await send(browser, '/api/portal/connect', { ...payload, apiKey: 'z'.repeat(32) })).status).toBe(400);
    validationStatus = 200;
    expect(await store.getKey(personalOwner(alice.id), 'odp')).toBe(key);
    const denied = await send(browser, '/api/portal/connect', { oauth_query, decision: 'deny' });
    expect(denied.status, await denied.clone().text()).toBe(200);
    const callback = new URL((await denied.json() as any).url);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe(state);
    await store.deleteKey(personalOwner(alice.id), 'odp', alice.id);
    await store.deleteKey(personalOwner(alice.id), 'tsdr', alice.id);
    // Keep unrelated rate-limit tests independent of this flow's validation attempts.
    await pool.query('DELETE FROM request_limits');
  });
  it('isolates saved keys, rejects CSRF and owner injection, and preserves keys on failed replacement', async () => {
    expect((await send(fetch, '/api/portal/keys', { apiKey: key })).status).toBe(401);
    expect((await send(browser, '/api/portal/keys', { apiKey: key }, 'https://evil.example')).status).toBe(403);
    expect((await send(browser, '/api/portal/keys', { apiKey: key, owner: personalOwner(bob.id) })).status).toBe(400);
    expect((await send(browser, '/api/portal/keys', { apiKey: key })).status).toBe(200);
    expect((await send(other, '/api/portal/keys', { apiKey: key2 })).status).toBe(200);
    expect(await store.getKey(personalOwner(alice.id), 'odp')).toBe(key);
    expect(await store.getKey(personalOwner(alice.id), 'tsdr')).toBeUndefined();
    const rows = await pool.query('SELECT ciphertext FROM credentials');
    expect(JSON.stringify(rows.rows)).not.toContain(key);
    const account = await (await browser(`${config.origin}/api/portal/account`)).json() as any;
    expect(JSON.stringify(account)).not.toContain(key);
    expect(account.keys).toMatchObject({ odp: { connected: true }, tsdr: { connected: false } });
    validationStatus = 403;
    expect((await send(browser, '/api/portal/keys', { apiKey: 'z'.repeat(32) })).status).toBe(400);
    validationStatus = 200;
    expect(await store.getKey(personalOwner(alice.id), 'odp')).toBe(key);
    // An empty body or an unknown kind is refused; a ciphertext never opens as the other kind.
    expect((await send(browser, '/api/portal/keys', {})).status).toBe(400);
    expect((await send(browser, '/api/portal/keys/delete', { kind: 'regs' })).status).toBe(400);
    await pool.query("INSERT INTO credentials(owner,kind,ciphertext) SELECT owner,'tsdr',ciphertext FROM credentials WHERE owner=$1 AND kind='odp'", [personalOwner(alice.id)]);
    await expect(store.getKey(personalOwner(alice.id), 'tsdr')).rejects.toThrow();
    await pool.query("DELETE FROM credentials WHERE owner=$1 AND kind='tsdr'", [personalOwner(alice.id)]);
  });
  it('keys per-IP limits on the trusted client header, not the proxy address', async () => {
    const bucket = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count;
    for (const ip of ['203.0.113.5', '203.0.113.5', '198.51.100.7'])
      expect((await fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: 'Bearer nope', 'x-real-ip': ip } })).status).toBe(401);
    // On Railway, req.ip would be the shared edge address; each client gets its own bucket instead.
    expect(await bucket('mcp-ip:203.0.113.5')).toBe(2);
    expect(await bucket('mcp-ip:198.51.100.7')).toBe(1);
  });
  it('serves documentation tools at /mcp without sign-in, and no execute or USPTO key there', async () => {
    const listTools = async (token?: string) => {
      const r = await fetch(`${config.origin}/mcp`, {
        method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Mcp-Method': 'tools/list', 'Mcp-Protocol-Version': '2026-07-28' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'auth-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
        } } }),
      });
      return { status: r.status, body: await r.text() };
    };
    const listed = await listTools();
    expect(listed.status).toBe(200);
    expect(listed.body).toContain('search_api');
    expect(listed.body).not.toContain('"execute"');
    // A bearer token is not required, and one sent here is ignored rather than checked.
    expect((await listTools('not-a-token')).status).toBe(200);
    // A direct execute call is refused even though tools/list never offered it.
    const direct = await mcp(undefined, 'return 42;', '/mcp');
    expect(direct.body).toMatch(/not found|Unknown tool/i);
    expect(direct.body).not.toContain('"value":42');
    // MCP's Origin rule, as in the base transport: other sites' browsers are refused.
    expect((await fetch(`${config.origin}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect(await (await fetch(`${config.origin}/api/portal/config`)).json()).toMatchObject({
      mcpUrl: `${config.origin}/mcp/account`, publicMcpUrl: `${config.origin}/mcp`,
    });
  });
  it('signs out mid-connection the way the Sign out button does, ending that session only', async () => {
    const session = await login(alice.id);
    const { oauth_query: connectQuery } = await beginAuthorization(session);
    const connect = await send(session, '/api/portal/connect', { oauth_query: connectQuery, decision: 'continue' });
    expect(connect.status, await connect.clone().text()).toBe(200);
    const oauth_query = signedQuery((await connect.json() as any).url);
    const consent = `${config.origin}/api/portal/consent?oauth_query=${encodeURIComponent(oauth_query)}`;
    expect((await session(consent)).status).toBe(200);
    // The button posts '{}' to Better Auth directly, without the page's signed query.
    expect((await send(session, '/api/auth/sign-out', {})).status).toBe(200);
    expect((await session(consent)).status).toBe(401);
    // Other sessions of the same user stay signed in.
    expect((await browser(`${config.origin}/api/portal/account`)).status).toBe(200);
  });
  it('enforces consent denial, signed queries, and PKCE', async () => {
    expect((await send(browser, '/api/portal/consent', { oauth_query: 'client_id=attacker', accept: true })).status).toBe(400);
    const denied = await authorize(browser, false);
    expect(denied.code).toBeNull(); expect(denied.callback.searchParams.get('error')).toBe('access_denied');
    const a = await authorize();
    expect((await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: randomToken(), redirect_uri: a.client.redirect_uris[0] })).status).toBe(400); // RFC 6749 §5.2 invalid_grant
  });
  it('routes each token to its owner, redacts upstream echoes, and applies rotation/removal on the next request', async () => {
    const a = await token(), b = await token(other);
    const upstream = mock.get(ODP);
    upstream.intercept({ path: META, method: 'GET', headers: { 'x-api-key': key } }).reply(200, { data: 'Alice', echo: key });
    upstream.intercept({ path: META, method: 'GET', headers: { 'x-api-key': key2 } }).reply(200, { data: 'Bob' });
    const call = 'return await odp.patents.metaData("17248024");';
    const [ra, rb] = await Promise.all([mcp(a.access_token, call), mcp(b.access_token, call)]);
    expect(ra.body).toContain('Alice'); expect(ra.body).not.toContain(key); expect(ra.body).toContain('REDACTED'); expect(rb.body).toContain('Bob');
    expect((await send(browser, '/api/portal/keys', { apiKey: 'c'.repeat(32) })).status).toBe(200);
    upstream.intercept({ path: META, method: 'GET', headers: { 'x-api-key': 'c'.repeat(32) } }).reply(200, { data: 'Rotated' });
    expect((await mcp(a.access_token, call)).body).toContain('Rotated');
    expect((await send(browser, '/api/portal/keys/delete', { kind: 'odp' })).status).toBe(200);
    expect((await mcp(a.access_token, call)).body).toContain('Save your USPTO Open Data Portal API key');
    expect((await mcp(a.access_token)).body).toContain('42');
    expect(await store.getKey(personalOwner(bob.id), 'odp')).toBe(key2);
  });
  it('keeps ODP and TSDR keys independent, and serializes one account\'s calls per key', async () => {
    const a = await token();
    expect((await send(browser, '/api/portal/keys', { apiKey: key, tsdrApiKey: tsdrKey })).status).toBe(200);
    mock.get(TSDR).intercept({ path: '/ts/cd/casestatus/sn97123456/info', method: 'GET', headers: { 'uspto-api-key': tsdrKey } })
      .reply(200, { trademarks: [{ status: { markElement: 'AZUKI ZEN' } }] });
    store.reads = [];
    expect((await mcp(a.access_token, 'return (await tsdr.status("97123456")).trademarks[0].status.markElement;')).body).toContain('AZUKI ZEN');
    expect(store.reads).toEqual(['tsdr']);
    // Two parallel calls on one key: USPTO allows one in flight, so the second waits its turn.
    const started: number[] = [];
    mock.get(ODP).intercept({ path: p => p.startsWith('/api/v1/patent/applications/1724802'), method: 'GET', headers: { 'x-api-key': key } })
      .reply(() => { started.push(Date.now()); return { statusCode: 200, data: { ok: true } }; })
      .delay(80).times(2);
    store.reads = [];
    const both = await mcp(a.access_token, 'const r = await Promise.all([odp.patents.get("17248024"), odp.patents.get("17248025")]); return r.length;');
    expect(both.body).toContain('2');
    expect(started).toHaveLength(2);
    // The second request only starts once the first (delayed 80ms) has completed.
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(70);
    expect(store.reads).toEqual(['odp']);
    await store.deleteKey(personalOwner(alice.id), 'odp', alice.id);
    await store.deleteKey(personalOwner(alice.id), 'tsdr', alice.id);
  });
  it('keeps upstream error status without the key, and keeps other sources working when a saved key cannot be read', async () => {
    const a = await token();
    expect((await send(browser, '/api/portal/keys', { apiKey: key, tsdrApiKey: tsdrKey })).status).toBe(200);
    mock.get(ODP)
      .intercept({ path: '/api/v1/patent/trials/proceedings/IPR0000-00000', method: 'GET', headers: { 'x-api-key': key } })
      .reply(404, { errorDetails: key });
    const missing = await mcp(a.access_token, 'try { await odp.ptab.proceedings.get("IPR0000-00000"); } catch (e) { return `${e.name}: ${e.message} ${e.status}`; }');
    expect(missing.body).toContain('NotFound');
    expect(missing.body).toContain('404');
    expect(missing.body).not.toContain(key);
    // A ciphertext sealed under a retired key ID can no longer be opened.
    await pool.query(`UPDATE credentials SET ciphertext = jsonb_set(ciphertext, '{kid}', '"retired"') WHERE owner=$1 AND kind='odp'`, [personalOwner(alice.id)]);
    expect((await mcp(a.access_token)).body).toContain('42');
    expect((await mcp(a.access_token, 'return await odp.patents.metaData("17248024");')).body).toContain('could not be loaded');
    mock.get(TSDR).intercept({ path: '/last-update/info.json?sn=97123456', method: 'GET', headers: { 'uspto-api-key': tsdrKey } }).reply(200, { caseUpdateInfo: [] });
    expect((await mcp(a.access_token, 'return await tsdr.lastUpdate("97123456");')).body).toContain('caseUpdateInfo');
    await store.deleteKey(personalOwner(alice.id), 'odp', alice.id);
    await store.deleteKey(personalOwner(alice.id), 'tsdr', alice.id);
  });
  it('reads a key only for its own source, reuses response caches, and accepts large requests', async () => {
    const b = await token(other);
    const own = 'd'.repeat(32);
    expect((await send(other, '/api/portal/keys', { apiKey: own })).status).toBe(200);
    const before = store.keyReads;
    // Over the 64KB cap account mode used to apply; the base HTTP transport has none.
    const large = await mcp(b.access_token, `// ${'x'.repeat(100_000)}\nreturn 42;`);
    expect(large.status).toBe(200);
    expect(large.body).toContain('42');
    expect(store.keyReads).toBe(before);
    // One upstream reply serves both executions: the second comes from the cached client.
    mock.get(ODP)
      .intercept({ path: '/api/v1/datasets/products/PTGRXML', method: 'GET', headers: { 'x-api-key': own } })
      .reply(200, { data: 'Cached product' });
    for (let i = 0; i < 2; i++)
      expect((await mcp(b.access_token, 'return await odp.bulk.get("PTGRXML");')).body).toContain('Cached product');
    expect(store.keyReads).toBe(before + 2);
    await store.deleteKey(personalOwner(bob.id), 'odp', bob.id);
  });
  it('supports the official MCP client and rejects expired, wrong-resource, under-scoped and disabled-client tokens', async () => {
    const a = await token();
    const client = new Client({ name: 'official-auth-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${config.origin}/mcp/account`), {
      requestInit: { headers: { Authorization: `Bearer ${a.access_token}` } },
    }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['search_api', 'describe_schema', 'execute']);
    await client.close();
    const adapter = (await service.auth.$context).adapter;
    const where = [{ field: 'token', value: digest(a.access_token) }];
    const row = await adapter.findOne<any>({ model: 'oauthAccessToken', where });
    for (const [update, status] of [
      [{ expiresAt: new Date(0) }, 401],
      [{ resources: ['https://other.example/mcp'] }, 401],
      [{ scopes: ['offline_access'] }, 403],
    ] as const) {
      await adapter.update({ model: 'oauthAccessToken', where, update });
      expect((await mcp(a.access_token)).status).toBe(status);
      await adapter.update({ model: 'oauthAccessToken', where, update: { expiresAt: row.expiresAt, resources: row.resources, scopes: row.scopes } });
    }
    await adapter.update({ model: 'oauthClient', where: [{ field: 'clientId', value: a.clientId }], update: { disabled: true } });
    expect((await mcp(a.access_token)).status).toBe(401);
    const stored = await pool.query('SELECT token FROM "oauthAccessToken"');
    expect(JSON.stringify(stored.rows)).not.toContain(a.access_token);
  });
  it('rejects unverified accounts, foreign browser origins, oversized bodies and unsafe client redirects', async () => {
    const unverified = await helper.saveUser(helper.createUser({ email: 'unverified@example.test', emailVerified: false }));
    const unverifiedBrowser = await login(unverified.id);
    expect((await send(unverifiedBrowser, '/api/portal/keys', { apiKey: key })).status).toBe(401);
    const cross = await fetch(`${config.origin}/api/portal/account`, { headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await send(browser, '/api/portal/keys', { apiKey: 'x'.repeat(9000) })).status).toBe(413);
    expect((await send(fetch, '/api/auth/oauth2/register', { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    const a = await token();
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: false } });
    expect((await mcp(a.access_token)).status).toBe(401);
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: true } });
  });
  it('rotates refresh tokens and honors access token revocation', async () => {
    const a = await token();
    const response = await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
    expect(response.status, await response.clone().text()).toBe(200);
    const refreshed = await response.json() as any;
    expect(refreshed.refresh_token).not.toBe(a.refresh_token);
    expect((await mcp(refreshed.access_token)).status).toBe(200);
    const revoke = await fetch(`${config.origin}/api/auth/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ client_id: a.clientId, token: refreshed.access_token, token_type_hint: 'access_token' }) });
    expect(revoke.status).toBe(200); expect((await mcp(refreshed.access_token)).status).toBe(401);
    expect((await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token })).status).toBe(400);
  });
});
