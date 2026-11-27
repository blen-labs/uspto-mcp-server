import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readBuildInfo } from '../src/server/buildInfo.js';
import { Agent, createServer, get as httpGet, request as httpRequest, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { testUtils } from 'better-auth/plugins';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { MockAgent } from 'undici';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Keyring, randomToken, digest } from '../src/accounts/crypto.js';
import { AccessTokenFormat } from '../src/accounts/token-admission.js';
import { Store, personalOwner, type KeyKind } from '../src/accounts/store.js';
import { SERVER_VERSION } from '../src/server/mcpServer.js';
import { createAccountApp, allowedRedirect, lockTarget, advisoryId } from '../src/accounts/app.js';
import { accountDependencies, publicDependencies } from '../src/accounts/runtime.js';
import { loadAccountConfig, type AccountConfig } from '../src/accounts/config.js';
import { checkKey } from '../src/accounts/portal.js';
import { gateFor, gateHandle, gateCount } from '../src/accounts/keyGates.js';
import { LIMIT_DEFAULTS } from '../src/supervisor/index.js';
import { buildSupervisor, type SupervisorConfig } from '../src/supervisor/index.js';
import { supervisorCfg } from './helpers.js';
import { generateKeyPair, exportJWK } from 'jose';
import { ClaudeLink, loadClaudeLinkConfig, type ClaudeLinkConfig } from '../src/accounts/claudeLink.js';
import { FakeClaude } from './fakeClaude.js';

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
  // eslint-disable-next-line no-script-url -- asserting that a javascript: redirect is refused
  for (const url of ['http://evil.example/cb', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/#fragment']) expect(allowedRedirect(url)).toBe(false);
  expect(allowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  expect(allowedRedirect('http://127.0.0.1:1234/cb')).toBe(true);
});

it('turns linked Claude billing on only with its client ID, then requires every setting', () => {
  const origin = 'https://uspto.example';
  const jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd', kid: 'k1' });
  const all = {
    USPTO_CLAUDE_LINK_CLIENT_ID: 'clid_1', USPTO_CLAUDE_LINK_SIGNING_JWK: jwk, USPTO_CLAUDE_LINK_ORGANIZATION_ID: 'cd4e3d5c-0000',
    USPTO_CLAUDE_LINK_SERVICE_ACCOUNT_ID: 'svac_1', USPTO_CLAUDE_LINK_FEDERATION_RULE_ID: 'fdrl_1', USPTO_CLAUDE_LINK_WORKSPACE_ID: 'wrkspc_1',
  };
  // A signing key alone (as deployed before the feature is switched on) changes nothing.
  expect(loadClaudeLinkConfig({ USPTO_CLAUDE_LINK_SIGNING_JWK: jwk }, origin)).toBeUndefined();
  expect(loadClaudeLinkConfig(all, origin)).toMatchObject({
    clientId: 'clid_1', issuer: `${origin}/claude-link`, redirectUri: `${origin}/api/portal/claude/callback`, workspaceId: 'wrkspc_1',
  });
  for (const name of Object.keys(all).filter(n => n !== 'USPTO_CLAUDE_LINK_CLIENT_ID')) {
    expect(() => loadClaudeLinkConfig({ ...all, [name]: '' }, origin)).toThrow(name);
  }
  // A public key, or one without a kid, cannot sign; the error never repeats the key material.
  const publicOnly = JSON.parse(jwk); delete publicOnly.d;
  expect(() => loadClaudeLinkConfig({ ...all, USPTO_CLAUDE_LINK_SIGNING_JWK: JSON.stringify(publicOnly) }, origin)).toThrow(/private P-256 JWK/);
  try { loadClaudeLinkConfig({ ...all, USPTO_CLAUDE_LINK_SIGNING_JWK: '{"d":"secret-material"' }, origin); throw new Error('expected a failure'); }
  catch (error) { expect(String(error)).not.toContain('secret-material'); }
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

it('a credential gate uses the configured limits even when a key check creates it', async () => {
  const { configureKeyGates } = await import('../src/accounts/keyGates.js');
  configureKeyGates({ odp: { ...LIMIT_DEFAULTS.odp, concurrency: 1, maxWaitMs: 30 }, tsdr: LIMIT_DEFAULTS.tsdr });
  try {
    const g = gateFor('odp', 'configured-credential-0123456789'); // created by a key check: no limits passed
    const held = await g.acquire();
    await expect(g.acquire()).rejects.toThrow(/30ms/); // the configured maxWaitMs, not the 30 s default
    held();
  } finally {
    configureKeyGates({ odp: LIMIT_DEFAULTS.odp, tsdr: LIMIT_DEFAULTS.tsdr });
  }
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
  let pool: Pool, store: CountingStore, server: Server, config: AccountConfig, docsRoot: string;
  let service: Awaited<ReturnType<typeof createAccountApp>>;
  let startReplica: (tuning?: Parameters<typeof createAccountApp>[5], overrides?: Partial<AccountConfig>, replicaStore?: Store) => ReturnType<typeof createAccountApp>;
  let helper: ReturnType<ReturnType<typeof testUtils>['init']>['context']['test'];
  let alice: any, bob: any, browser: typeof fetch, other: typeof fetch;
  let validationStatus = 200;
  let claude: FakeClaude, claudeConfig: ClaudeLinkConfig;
  const claudeFetch = (async (url: unknown, init?: RequestInit) =>
    await claude.handle(url, init) ?? new Response(null, { status: validationStatus })) as typeof fetch;
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
  async function register(method = 'none') {
    const response = await send(fetch, '/api/auth/oauth2/register', {
      client_name: 'Test assistant', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as any;
  }
  async function beginAuthorization(clientBrowser = browser, method = 'none') {
    const client = await register(method);
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
  async function authorize(clientBrowser = browser, accept = true, method = 'none') {
    const { client, verifier, state, oauth_query: connectQuery } = await beginAuthorization(clientBrowser, method);
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
  /** Issues and verifies tokens like the server does (same secret), for forging MAC-valid ones. */
  let accessTokens: AccessTokenFormat;
  /** `count` further valid tokens for the same grant: each a distinct, MAC-valid value with its own database row. */
  async function validTokens(access: string, count: number, make: () => string = () => accessTokens.generate()) {
    const { adapter } = await service.auth.$context;
    const row = await adapter.findOne<Record<string, unknown>>({ model: 'oauthAccessToken', where: [{ field: 'token', value: digest(access) }] });
    expect(row).toBeTruthy();
    const { id: _id, ...data } = row!;
    const created = Array.from({ length: count }, make);
    for (const value of created) await adapter.create({ model: 'oauthAccessToken', data: { ...data, token: digest(value) } });
    return created;
  }
  /** At most 32 sockets at once: hundreds of simultaneous connects overflow the listen backlog on some systems. */
  const agent = new Agent({ keepAlive: true, maxSockets: 32 });
  const rawPost = (token: string, ip: string) => new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${config.origin}/mcp/account`, { method: 'POST', agent, headers: { authorization: `Bearer ${token}`, 'x-real-ip': ip } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    request.on('error', reject);
    request.end();
  });
  /** A token of a confidential client (it can introspect), with its secret. */
  async function confidentialToken() {
    const a = await authorize(browser, true, 'client_secret_post');
    const secret = a.client.client_secret as string;
    expect(secret).toBeTruthy();
    const response = await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: a.verifier, redirect_uri: a.client.redirect_uris[0], client_secret: secret });
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...await response.json() as any, clientId: a.client.client_id as string, secret };
  }
  beforeAll(async () => {
    const admin = new Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
    pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
    store = new CountingStore(pool, new Keyring('v1', { v1: randomBytes(32) }));
    await store.initialize();
    // A minimal built docs site: /docs must be wired with its own CSP inside the account app.
    docsRoot = mkdtempSync(join(tmpdir(), 'uspto-docs-'));
    writeFileSync(join(docsRoot, 'index.html'), '<html><script>window.docs=1</script><title>Docs</title></html>');
    server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config = { origin: `http://127.0.0.1:${(server.address() as any).port}`, production: false,
      databaseUrl: database!, authSecret: randomToken(), googleClientId: 'fixture-google', googleClientSecret: 'fixture-secret', keyring: new Keyring('v1', { v1: randomBytes(32) }),
      clientIpHeader: 'x-real-ip', docsRoot };
    // Linked Claude billing against a strict fake of auth.claude.com and api.anthropic.com.
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    claudeConfig = {
      clientId: 'clid_test', signingKey: { ...await exportJWK(privateKey), kid: 'test-kid' },
      issuer: `${config.origin}/claude-link`, redirectUri: `${config.origin}/api/portal/claude/callback`,
      organizationId: 'org-test', serviceAccountId: 'svac_test', federationRuleId: 'fdrl_test', workspaceId: 'wrkspc_test',
    };
    config.claudeLink = claudeConfig;
    claude = new FakeClaude(claudeConfig, publicKey);
    const deps = await buildSupervisor(cfg);
    expect(await deps.sandbox.available(), 'Deno is required for account integration tests').toBe(true);
    // Upstream USPTO calls go through an injected MockAgent, never the global dispatcher.
    mock = new MockAgent(); mock.disableNetConnect();
    // The anonymous endpoint gets no shared key here, so USPTO calls there must point to sign-in.
    const publicDeps = publicDependencies(await buildSupervisor(cfg), config.origin); // cfg HAS a shared key: it must stay unused
    service = await createAccountApp(config, store, accountDependencies(deps, cfg, store, mock), claudeFetch, publicDeps);
    server.on('request', service.app);
    accessTokens = new AccessTokenFormat(config.authSecret);
    startReplica = (tuning, overrides, replicaStore) =>
      createAccountApp({ ...config, ...overrides }, replicaStore ?? store, accountDependencies(deps, cfg, store, mock), claudeFetch, publicDeps, tuning);
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
  it('serves /health with the running version and commit, and checks the database', async () => {
    expect(await (await fetch(`${config.origin}/health`)).json()).toEqual({
      status: 'ok', protocolVersion: '2026-07-28', sandbox: 'deno', version: SERVER_VERSION, commit: null,
    });
    // The commit is the platform's, read when the app starts; a replica started with one reports it.
    const replica = await startReplica({ buildInfo: readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: 'c'.repeat(40) }) });
    await withReplica(replica, async () => {
      expect(await (await fetch(`${config.origin}/health`)).json()).toMatchObject({ status: 'ok', version: SERVER_VERSION, commit: 'c'.repeat(40) });
    });
  });
  it('registers desktop clients with loopback HTTP redirects even without application_type', async () => {
    for (const uri of ['http://127.0.0.1:33418/callback', 'http://localhost:33418/callback', 'http://[::1]:33418/callback']) {
      const r = await send(fetch, '/api/auth/oauth2/register', {
        client_name: 'Desktop client', redirect_uris: [uri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      });
      expect(r.status, `${uri}: ${await r.clone().text()}`).toBe(201);
    }
    // Non-loopback HTTP stays refused, at registration and in a JSON-bodied authorize request.
    expect((await send(fetch, '/api/auth/oauth2/register', { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await send(fetch, '/api/auth/oauth2/authorize', { client_id: 'x', redirect_uri: 'http://evil.example/cb', response_type: 'code' })).status).toBe(400);
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
  it('serves the documentation site at /docs with its own CSP, behind the Host check', async () => {
    const moved = await fetch(`${config.origin}/docs?q=1`, { redirect: 'manual' });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('/docs/?q=1');
    const page = await fetch(`${config.origin}/docs/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Docs</title>');
    // The docs policy replaces the portal's, and allows the inline script only by its hash.
    expect(page.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update('window.docs=1').digest('base64')}'`);
    expect(page.headers.get('cache-control')).toBe('public, max-age=300');
    // fetch cannot set Host (a forbidden header), so the rebinding check goes through node:http.
    const { port } = new URL(config.origin);
    const status = await new Promise<number | undefined>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path: '/docs/', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    expect(status).toBe(421);
  });
  // Needs the Vite bundle: `pnpm build` (CI builds before testing). Skipped, not failed, without it.
  const webBuilt = existsSync(new URL('../dist/web/index.html', import.meta.url));
  it.skipIf(!webBuilt)('serves the SAM.gov-style frontend and policies with same-origin assets (needs pnpm build)', async () => {
    for (const path of ['/', '/sign-in', '/account', '/connect', '/consent', '/privacy-policy', '/terms', '/error']) {
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
    // An unknown path: a browser navigation gets the portal's not-found page with status 404;
    // an API client keeps the short text answer.
    // fetch() always sends `sec-fetch-mode: cors`, so send a browser navigation with node:http.
    const { port } = new URL(config.origin);
    const page = await new Promise<{ status?: number; type?: string; body: string }>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path: '/no-such-page', headers: { host: new URL(config.origin).host, 'sec-fetch-mode': 'navigate', accept: 'text/html' } }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk)).on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      }).on('error', reject));
    expect(page.status).toBe(404);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('/assets/');
    const api = await fetch(`${config.origin}/no-such-page`, { headers: { accept: 'application/json' } });
    expect(api.status).toBe(404);
    expect(await api.text()).toBe('Not found');
  });
  // The policy URLs are registered as the connector's privacy policy, so their text must be in the
  // HTML itself (web/prerender.ts), not only rendered by the script. node:http: no JavaScript runs.
  it.skipIf(!webBuilt)('serves the policy pages with their text in the HTML, without running JavaScript (needs pnpm build)', async () => {
    const { port, host } = new URL(config.origin);
    const get = (path: string) => new Promise<{ status?: number; csp?: string | string[]; body: string }>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk)).on('end', () => resolve({ status: res.statusCode, csp: res.headers['content-security-policy'], body }));
      }).on('error', reject));
    const pages = [
      { path: '/privacy-policy', title: 'Privacy policy', source: 'privacy-policy.md' },
      { path: '/terms', title: 'Terms of service', source: 'terms.md' },
    ];
    const plain = (html: string) => {
      // Strip tags until none are left: one pass can leave a tag assembled from the pieces around a removed one.
      let text = html;
      for (let prev = ''; prev !== text; ) { prev = text; text = text.replace(/<[^>]*>/g, ''); }
      return text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
    };
    for (const { path, title, source } of pages) {
      const headings = [...readFileSync(new URL(`../legal/${source}`, import.meta.url), 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
      expect(headings.length).toBeGreaterThan(3);
      for (const url of [path, `${path}/`]) {
        const page = await get(url);
        expect(page.status, url).toBe(200);
        expect(page.csp).toContain("script-src 'self'");
        expect(page.body).toMatch(new RegExp(`<title>${title} · `));
        expect(page.body).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
        expect(page.body).toContain('<main id="main"');
        const text = plain(page.body);
        for (const heading of headings) expect(text, heading).toContain(heading);
        expect(page.body).toContain('<script type="module"');
        expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
      }
    }
  });
  // OAuth 2.0 lets a client with one registered URI omit redirect_uri. Better Auth refuses that, so
  // a signed Connect/Consent query always names one; the portal still answers 400, not 500, without it.
  it('refuses an authorization request without redirect_uri before the Connect page', async () => {
    const client = await register();
    const query = new URLSearchParams({
      client_id: client.client_id, response_type: 'code', scope: 'uspto:read', resource: `${config.origin}/mcp/account`,
      code_challenge: createHash('sha256').update(randomToken()).digest('base64url'), code_challenge_method: 'S256', state: randomToken(),
    });
    let response = await browser(`${config.origin}/api/auth/oauth2/authorize?${query}`, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } });
    if (response.headers.get('content-type')?.includes('application/json')) response = await browser(new URL((await response.json() as any).url, config.origin));
    expect(new URL(response.url).pathname).not.toBe('/connect');
    await response.arrayBuffer();
  });
  it('validates the separate connection step, preserves saved keys on failure, and allows cancellation', async () => {
    const { oauth_query, state } = await beginAuthorization();
    const payload = { oauth_query, decision: 'continue' };
    expect((await send(fetch, '/api/portal/connect', payload)).status).toBe(401);
    expect((await send(browser, '/api/portal/connect', payload, 'https://evil.example')).status).toBe(403);
    expect((await send(browser, '/api/portal/connect', { ...payload, oauth_query: `${oauth_query}&client_id=attacker` })).status).toBe(400);
    expect((await send(browser, '/api/portal/connect', { ...payload, owner: personalOwner(bob.id) })).status).toBe(400);
    // Not about a typed key: no field, so the page shows a notice instead of a field error.
    const expired = await send(browser, '/api/portal/connect', { ...payload, oauth_query: `${oauth_query}&client_id=attacker` });
    expect(await expired.json()).toEqual({ error: 'Connection authorization failed.' });
    const info = await browser(`${config.origin}/api/portal/connect?oauth_query=${encodeURIComponent(oauth_query)}`);
    expect(await info.json()).toMatchObject({ email: alice.email, client: 'Test assistant', keys: { odp: { connected: false }, tsdr: { connected: false } } });
    expect((await send(browser, '/api/portal/connect', { ...payload, apiKey: key, tsdrApiKey: tsdrKey })).status).toBe(200);
    expect(await store.getKey(personalOwner(alice.id), 'odp')).toBe(key);
    expect(await store.getKey(personalOwner(alice.id), 'tsdr')).toBe(tsdrKey);
    validationStatus = 403;
    const rejectedOdp = await send(browser, '/api/portal/connect', { ...payload, apiKey: 'z'.repeat(32) });
    expect(rejectedOdp.status).toBe(400);
    expect((await rejectedOdp.json() as any).field).toBe('apiKey');
    const rejectedTsdr = await send(browser, '/api/portal/connect', { ...payload, tsdrApiKey: 'z'.repeat(32) });
    expect(rejectedTsdr.status).toBe(400);
    expect((await rejectedTsdr.json() as any).field).toBe('tsdrApiKey');
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
    const rejected = await send(browser, '/api/portal/keys', { apiKey: 'z'.repeat(32) });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ field: 'apiKey' });
    const rejectedTsdr = await send(browser, '/api/portal/keys', { tsdrApiKey: 'z'.repeat(32) });
    expect(rejectedTsdr.status).toBe(400);
    expect(await rejectedTsdr.json()).toMatchObject({ field: 'tsdrApiKey' });
    validationStatus = 200;
    await pool.query('DELETE FROM request_limits'); // the checks above spent this account's key-check budget
    expect(await store.getKey(personalOwner(alice.id), 'odp')).toBe(key);
    // An empty body or an unknown kind is refused; a ciphertext never opens as the other kind.
    expect((await send(browser, '/api/portal/keys', {})).status).toBe(400);
    const unknownKind = await send(browser, '/api/portal/keys/delete', { kind: 'regs' });
    expect(unknownKind.status).toBe(400);
    expect((await unknownKind.json() as any).field).toBeUndefined();
    await pool.query("INSERT INTO credentials(owner,kind,ciphertext) SELECT owner,'tsdr',ciphertext FROM credentials WHERE owner=$1 AND kind='odp'", [personalOwner(alice.id)]);
    await expect(store.getKey(personalOwner(alice.id), 'tsdr')).rejects.toThrow();
    await pool.query("DELETE FROM credentials WHERE owner=$1 AND kind='tsdr'", [personalOwner(alice.id)]);
  });
  it('keys per-IP limits on the trusted client header, not the proxy address', async () => {
    const bucket = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count;
    // MAC-valid but unknown tokens are the ones that reach the database, so they are the ones the flood guard counts.
    for (const ip of ['203.0.113.5', '203.0.113.5', '198.51.100.7'])
      expect((await fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: `Bearer ${accessTokens.generate()}`, 'x-real-ip': ip } })).status).toBe(401);
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
    // The `${...}` is sandbox source (a template literal that runs inside execute), not a typo.
    // eslint-disable-next-line no-template-curly-in-string
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
    // A rejection is remembered for a minute, so each case gets its own token (a copy of the grant's row).
    const [expired, otherResource, underScoped, ofDisabledClient] = await validTokens(a.access_token, 4) as [string, string, string, string];
    for (const [value, update, status] of [
      [expired, { expiresAt: new Date(0) }, 401],
      [otherResource, { resources: ['https://other.example/mcp'] }, 401],
      [underScoped, { scopes: ['offline_access'] }, 403],
    ] as const) {
      await adapter.update({ model: 'oauthAccessToken', where: [{ field: 'token', value: digest(value) }], update });
      expect((await mcp(value)).status).toBe(status);
    }
    await adapter.update({ model: 'oauthClient', where: [{ field: 'clientId', value: a.clientId }], update: { disabled: true } });
    expect((await mcp(ofDisabledClient)).status).toBe(401);
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
    // Hosted connectors send their own Origin on the signed-in endpoint; with a valid bearer token
    // (never a cookie) and the Host check in place, they must be served.
    for (const origin of ['https://claude.ai', 'https://chatgpt.com']) {
      const hosted = await fetch(`${config.origin}/mcp/account`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.access_token}`, origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(hosted.status, origin).toBe(200);
      expect(hosted.headers.get('access-control-allow-origin')).toBe('*');
    }
    // The anonymous endpoint has no token to check, so another site's page is refused there.
    expect((await fetch(`${config.origin}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: false } });
    expect((await mcp(a.access_token)).status).toBe(401);
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: true } });
  });
  it('rotates stored keys past a row it cannot open, batch by batch', async () => {
    const k1 = randomBytes(32), k2 = randomBytes(32);
    const before = new Store(pool, new Keyring('k1', { k1 }));
    const owners = ['rot:a', 'rot:b', 'rot:c'];
    for (const owner of owners) await before.saveKey(owner, 'odp', `key-${owner}`, owner);
    // The first row in key order points at a key that is no longer in the keyring; another lost its key ID.
    await pool.query("UPDATE credentials SET ciphertext=jsonb_set(ciphertext,'{kid}','\"gone\"') WHERE owner='rot:a'");
    await before.saveKey('rot:d', 'odp', 'key-rot:d', 'rot:d');
    await pool.query("UPDATE credentials SET ciphertext=ciphertext - 'kid' WHERE owner='rot:d'");
    const after = new Store(pool, new Keyring('k2', { k1, k2 }));
    // Batches of one exercise the cursor; other tests' rows (another key) are skipped the same way.
    const { rotated, failed } = await after.rotateAllKeys(1);
    expect(failed).toContainEqual({ owner: 'rot:a', kind: 'odp' });
    expect(failed).toContainEqual({ owner: 'rot:d', kind: 'odp' });
    expect(rotated).toBe(2);
    for (const owner of ['rot:b', 'rot:c']) expect(await after.getKey(owner, 'odp')).toBe(`key-${owner}`);
    const kids = await pool.query("SELECT owner, ciphertext->>'kid' AS kid FROM credentials WHERE owner LIKE 'rot:%' ORDER BY owner");
    expect(kids.rows).toEqual([{ owner: 'rot:a', kid: 'gone' }, { owner: 'rot:b', kid: 'k2' }, { owner: 'rot:c', kid: 'k2' }, { owner: 'rot:d', kid: null }]);
    const audit = await pool.query("SELECT action FROM audit_events WHERE tenant='rot:a' AND action='credential.reencrypt_failed'");
    expect(audit.rowCount).toBe(1);
    expect(await after.rotateAllKeys(1)).toMatchObject({ rotated: 0 });
  });
  /** Starts a link as `who`, approves it at the fake Claude, and returns the callback URL. */
  async function startLink(who: typeof fetch) {
    const started = await send(who, '/api/portal/claude/link', {});
    expect(started.status, await started.clone().text()).toBe(200);
    const { code, state } = claude.approve((await started.json() as any).url);
    return `${config.origin}/api/portal/claude/callback?${new URLSearchParams({ code, state })}`;
  }
  const finishLink = async (who: typeof fetch, url: string) => {
    const r = await who(url, { redirect: 'manual' });
    expect(r.status).toBe(303);
    return r.headers.get('location');
  };
  const claudeStatus = async (who: typeof fetch) => await (await who(`${config.origin}/api/portal/claude`)).json() as any;

  it('links a Claude organization only for the user and session that started it', async () => {
    // The callback is a cross-site top-level GET from auth.claude.com: a Lax session cookie rides along, Strict would not.
    expect((await service.auth.$context).authCookies.sessionToken.attributes.sameSite?.toLowerCase()).toBe('lax');
    expect(await claudeStatus(browser)).toEqual({ enabled: true, linked: false });
    expect((await fetch(`${config.origin}/api/portal/claude`)).status).toBe(401);
    // Bob finishes Alice's link (e.g. an approval link someone sent him): refused before any call to Claude.
    const aliceLink = await startLink(browser);
    const exchanges = claude.count('auth.claude.com/v1/oauth/token');
    expect(await finishLink(other, aliceLink)).toBe('/account?claude=expired');
    expect(claude.count('auth.claude.com/v1/oauth/token')).toBe(exchanges);
    // The state was consumed by that attempt, so it is now useless to Alice too.
    expect(await finishLink(browser, aliceLink)).toBe('/account?claude=expired');
    expect(await claudeStatus(other)).toEqual({ enabled: true, linked: false });
    // A denial at Claude also consumes the state.
    const denied = new URL(await startLink(browser));
    denied.searchParams.delete('code'); denied.searchParams.set('error', 'access_denied');
    expect(await finishLink(browser, denied.toString())).toBe('/account?claude=denied');
    expect(await finishLink(browser, denied.toString())).toBe('/account?claude=expired');
    // Alice's own link completes; one user profile serves all of her attempts.
    expect(await finishLink(browser, await startLink(browser))).toBe('/account?claude=linked');
    expect(await claudeStatus(browser)).toMatchObject({ enabled: true, linked: true });
    expect(claude.profilesCreated).toBe(1);
    // Anthropic saw an opaque reference, never her email; the tokens are sealed at rest.
    const profile = claude.calls.find(c => c.url.endsWith('/v1/user_profiles'))!;
    expect(JSON.stringify(profile.body)).not.toContain('alice');
    const row = await pool.query('SELECT ciphertext::text AS sealed FROM claude_links WHERE owner=$1', [personalOwner(alice.id)]);
    expect(row.rows[0].sealed).not.toMatch(/at-|rt-/);
    // Only same-origin JSON may start or end a link, and a linked user must unlink first.
    expect((await send(browser, '/api/portal/claude/link', {}, 'https://evil.example')).status).toBe(403);
    expect((await send(browser, '/api/portal/claude/link', {})).status).toBe(409);
  });
  it('refreshes Claude tokens once under the lock, and forgets a connection Claude ended', async () => {
    const link = new ClaudeLink(claudeConfig, store, claudeFetch);
    const owner = personalOwner(alice.id);
    const first = await link.accessToken(owner);
    expect(first?.token).toMatch(/^at-/);
    expect(first?.userProfileId).toBe('uprof_1');
    // Expire the access token: two concurrent callers share one refresh, and the new pair is stored.
    await store.withClaudeLink(owner, async (row, save) => save({ tokens: { ...row!.tokens!, accessExpiresAt: 0 } }));
    const refreshes = () => claude.calls.filter(c => c.body.grant_type === 'refresh_token').length;
    const before = refreshes();
    const [a, b] = await Promise.all([link.accessToken(owner), link.accessToken(owner)]);
    expect(refreshes()).toBe(before + 1);
    expect(a?.token).toBe(b?.token);
    expect(a?.token).not.toBe(first?.token);
    expect(claude.calls.filter(c => c.body.grant_type === 'refresh_token').every(c => !('scope' in c.body))).toBe(true);
    expect((await link.accessToken(owner))?.token).toBe(a?.token);
    // A refresh whose response is lost is repeated once at once, with the same refresh token, and the link survives.
    claude.loseNextRefresh = true;
    await store.withClaudeLink(owner, async (row, save) => save({ tokens: { ...row!.tokens!, accessExpiresAt: 0 } }));
    const sent = refreshes();
    const repeated = await link.accessToken(owner);
    expect(refreshes()).toBe(sent + 2);
    expect(repeated?.token).toMatch(/^at-/);
    expect(await claudeStatus(browser)).toMatchObject({ linked: true });
    // The customer unlinked in their own Console: the next refresh gets invalid_grant, and the link is forgotten.
    claude.endConnections();
    await store.withClaudeLink(owner, async (row, save) => save({ tokens: { ...row!.tokens!, accessExpiresAt: 0 } }));
    expect(await link.accessToken(owner)).toBeUndefined();
    expect(await claudeStatus(browser)).toMatchObject({ linked: false });
  });
  it('revokes the older connection when two links started earlier both finish, even if that revocation fails', async () => {
    const connectionOf = async () => (await pool.query('SELECT connection_id, stale_connection_ids FROM claude_links WHERE owner=$1', [personalOwner(bob.id)])).rows[0];
    const [first, second, third] = [await startLink(other), await startLink(other), await startLink(other)];
    expect(await finishLink(other, first)).toBe('/account?claude=linked');
    const one = (await connectionOf()).connection_id;
    expect(await finishLink(other, second)).toBe('/account?claude=linked');
    expect(claude.calls.at(-1)).toMatchObject({ url: 'https://auth.claude.com/v1/oauth/revoke', body: { connection_id: one } });
    expect(claude.active.has(one)).toBe(false);
    expect((await connectionOf()).stale_connection_ids).toEqual([]);
    // The revocation of the replaced connection fails: its ID is kept, and Unlink still ends it.
    const two = (await connectionOf()).connection_id;
    claude.failNextRevoke = true;
    expect(await finishLink(other, third)).toBe('/account?claude=linked');
    expect(claude.active.has(two)).toBe(true);
    expect((await connectionOf()).stale_connection_ids).toEqual([two]);
    expect((await send(other, '/api/portal/claude/unlink', {})).status).toBe(200);
    expect(claude.calls.at(-1)!.body).toMatchObject({ user_profile_id: expect.stringMatching(/^uprof_/) });
    expect([...claude.active.keys()].filter(id => id === two || id === (one as string))).toEqual([]);
    expect(await connectionOf()).toEqual({ connection_id: null, stale_connection_ids: [] });
  });
  it('unlinks at Claude, keeps the user profile, and links again without a new one', async () => {
    await pool.query('DELETE FROM request_limits'); // the earlier tests used up Alice's 5 link attempts a minute
    const profiles = claude.profilesCreated;
    expect(await finishLink(browser, await startLink(browser))).toBe('/account?claude=linked');
    const revokes = claude.count('/v1/oauth/revoke');
    const unlinked = await send(browser, '/api/portal/claude/unlink', {});
    expect(unlinked.status, await unlinked.clone().text()).toBe(200);
    expect(claude.count('/v1/oauth/revoke')).toBe(revokes + 1);
    expect(claude.calls.at(-1)!.body.user_profile_id).toMatch(/^uprof_/);
    expect(await claudeStatus(browser)).toMatchObject({ linked: false });
    expect(await finishLink(browser, await startLink(browser))).toBe('/account?claude=linked');
    expect(claude.profilesCreated).toBe(profiles);
    const audit = await pool.query("SELECT action FROM audit_events WHERE tenant=$1 AND action LIKE 'claude.link.%' ORDER BY id", [personalOwner(alice.id)]);
    expect(audit.rows.map(r => r.action)).toEqual(['claude.link.created', 'claude.link.expired', 'claude.link.created', 'claude.link.revoked', 'claude.link.created']);
  });
  it('re-encrypts linked Claude tokens during key rotation', async () => {
    const k1 = randomBytes(32), k2 = randomBytes(32);
    const before = new Store(pool, new Keyring('k1', { k1 }));
    await before.withClaudeLink('rotc:a', async (_row, save) => save({ userProfileId: 'uprof_rot', connectionId: 'ocon_rot', tokens: { accessToken: 'at-rot', accessExpiresAt: Date.now() + 3_600_000 } }));
    const after = new Store(pool, new Keyring('k2', { k1, k2 }));
    await after.rotateAllKeys(1);
    const kid = await pool.query("SELECT ciphertext->>'kid' AS kid FROM claude_links WHERE owner='rotc:a'");
    expect(kid.rows[0].kid).toBe('k2');
    expect(await after.withClaudeLink('rotc:a', async row => row?.tokens?.accessToken)).toBe('at-rot');
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
  /** Serves the test server from another replica of the account app until `fn` finishes. */
  async function withReplica<T>(replica: Awaited<ReturnType<typeof createAccountApp>>, fn: () => Promise<T>): Promise<T> {
    server.removeListener('request', service.app); server.on('request', replica.app);
    try { return await fn(); }
    finally { server.removeListener('request', replica.app); server.on('request', service.app); await replica.close(); }
  }
  /** Holds one advisory lock on its own connection while `run` is in flight. */
  async function holding<T extends { status: number }>(id: string, run: () => Promise<T>, waitMs = 400) {
    const hold = await pool.connect();
    try {
      await hold.query('BEGIN'); await hold.query('SELECT pg_advisory_xact_lock($1)', [id]);
      const pending = run();
      const waits = await Promise.race([pending.then(() => false), new Promise<boolean>(r => setTimeout(r, waitMs, true))]);
      await hold.query('COMMIT');
      return { waits, response: await pending };
    } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
  }
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
  const oauthPost = (path: string, body: string | URLSearchParams, headers: Record<string, string> = FORM) =>
    fetch(`${config.origin}/api/auth/oauth2/${path}`, { method: 'POST', headers, body });
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const advisoryHeld = async () => Number((await pool.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid<>pg_backend_pid()")).rows[0].count);

  it('locks the operation Better Auth runs, parsed as it parses the body', async () => {
    const user = advisoryId(`user:${alice.id}`);
    const waitsAndSucceeds = async (id: string, run: () => Promise<Response>, label: string) => {
      const { waits, response } = await holding(id, run);
      expect(waits, `${label} must wait for its lock`).toBe(true);
      expect(response.status, `${label}: ${await response.clone().text()}`).toBe(200);
      return response;
    };
    // Revoke acts on `token`, wherever decoy refresh_token fields appear.
    const first = await token();
    await waitsAndSucceeds(user, () => oauthPost('revoke', `refresh_token=junk&${form({ client_id: first.clientId, token: first.refresh_token })}&refresh_token=junk2`), 'revoke by token');
    // ...and with its authorization scheme, which Better Auth strips.
    const second = await token();
    await waitsAndSucceeds(user, () => oauthPost('revoke', form({ client_id: second.clientId, token: `Bearer ${second.access_token}`, token_type_hint: 'access_token' })), 'revoke with Bearer scheme');
    // A refresh grant locks on refresh_token even behind a `{}`-prefixed pair (a JSON sniffer's trap),
    // extra fields, a padded grant_type and a harmless repeat of the same value.
    const third = await token();
    const refreshed = await (await waitsAndSucceeds(user, () => oauthPost('token', `{}=1&token=junk&code=junk&${form({ client_id: third.clientId, grant_type: ' refresh_token ', refresh_token: third.refresh_token })}`), 'refresh grant')).json() as any;
    // A harmless repeat of the same value is still locked on.
    const repeated = await token();
    expect((await holding(user, () => oauthPost('token', `${form({ client_id: repeated.clientId, grant_type: 'refresh_token', refresh_token: repeated.refresh_token })}&refresh_token=${repeated.refresh_token}`))).waits).toBe(true);
    // The lock is chosen with the parser Better Auth uses, so a BOM is handled exactly as it handles it.
    const bomRefresh = ((await (await waitsAndSucceeds(user, () => oauthPost('token', `\uFEFF${form({ client_id: third.clientId, grant_type: 'refresh_token', refresh_token: refreshed.refresh_token })}`), 'BOM-prefixed refresh grant')).json()) as any).refresh_token as string;
    const bomFirst = await holding(user, () => oauthPost('token', `\uFEFF${form({ grant_type: 'refresh_token', client_id: third.clientId, refresh_token: bomRefresh })}`));
    // Whatever this runtime's parser does with the BOM, an accepted request never runs unlocked.
    expect(bomFirst.response.status === 200 ? bomFirst.waits : true).toBe(true);
    expect(bomFirst.response.status).toBeLessThan(500);
    // A code exchange locks on its code, never on a stray refresh_token.
    const flow = await authorize();
    await waitsAndSucceeds(advisoryId(`code:${flow.code}`), () => oauthPost('token', form({ client_id: flow.client.client_id, grant_type: 'authorization_code', code: flow.code!, code_verifier: flow.verifier, redirect_uri: flow.client.redirect_uris[0], refresh_token: 'junk' })), 'code exchange');
    // Requests with nothing to lock do not wait, whatever lock is held: not on the user's...
    const fourth = await token(); const client = fourth.clientId;
    for (const [label, run] of [
      ['client_credentials with a refresh_token', () => oauthPost('token', form({ client_id: client, grant_type: 'client_credentials', refresh_token: fourth.refresh_token }))],
      ['no grant_type', () => oauthPost('token', form({ client_id: client, refresh_token: fourth.refresh_token }))],
      ['refresh grant without a token', () => oauthPost('token', form({ client_id: client, grant_type: 'refresh_token', token: fourth.refresh_token }))],
      ['revoke by refresh_token only', () => oauthPost('revoke', form({ client_id: client, refresh_token: fourth.refresh_token }))],
      ['JSON body', () => oauthPost('token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: fourth.refresh_token }), { 'content-type': 'application/json' })],
      ['no content type', () => fetch(`${config.origin}/api/auth/oauth2/token`, { method: 'POST', body: Buffer.from(form({ grant_type: 'refresh_token', refresh_token: fourth.refresh_token })) })],
    ] as const) {
      const { waits, response } = await holding(user, run, 300);
      expect(waits, `${label} must not take the user's lock`).toBe(false);
      expect(response.status, label).toBeLessThan(500);
    }
    // ...and not on the old shared `code:` key either.
    const shared = await holding(advisoryId('code:'), () => oauthPost('token', form({ client_id: client, grant_type: 'authorization_code' })), 300);
    expect(shared.waits).toBe(false);
    expect(shared.response.status).toBeLessThan(500);
    // The refresh token the decoys never touched still works.
    expect((await exchange(client, { grant_type: 'refresh_token', refresh_token: fourth.refresh_token })).status).toBe(200);
  });
  it('every accepted refresh, revoke and code exchange takes its lock, including leading-? bodies', async () => {
    const user = advisoryId(`user:${alice.id}`);
    // Whether this runtime's form parser keeps or drops a leading '?', a request Better Auth accepts
    // must have waited for the lock it was chosen with: never 200 without waiting.
    const accepted = async (label: string, id: string, run: () => Promise<Response>) => {
      const { waits, response } = await holding(id, run);
      expect(response.status, label).toBeLessThan(500);
      if (response.status === 200) expect(waits, `${label} ran without its lock`).toBe(true);
      return response.status;
    };
    let ran = 0;
    for (const variant of [
      (c: string, r: string) => `?${form({ grant_type: 'refresh_token', refresh_token: r, client_id: c })}`,
      (c: string, r: string) => `?${form({ refresh_token: r, grant_type: 'refresh_token', client_id: c })}`,
      (c: string, r: string) => `?a=1&${form({ grant_type: 'refresh_token', refresh_token: r, client_id: c })}`,
      (c: string, r: string) => form({ grant_type: 'refresh_token', refresh_token: r, client_id: c }),
    ]) {
      const t = await token();
      if (await accepted(`refresh ${variant('C', 'R')}`, user, () => oauthPost('token', variant(t.clientId, t.refresh_token))) === 200) ran++;
    }
    for (const variant of [
      (c: string, r: string) => `?${form({ token: `Bearer ${r}`, client_id: c })}`,
      (c: string, r: string) => `?${form({ token: r, client_id: c })}`,
      (c: string, r: string) => form({ token: r, client_id: c }),
    ]) {
      const t = await token();
      if (await accepted(`revoke ${variant('C', 'R')}`, user, () => oauthPost('revoke', variant(t.clientId, t.refresh_token))) === 200) ran++;
    }
    const flow = await authorize();
    const fields = { code: flow.code!, grant_type: 'authorization_code', code_verifier: flow.verifier, redirect_uri: flow.client.redirect_uris[0], client_id: flow.client.client_id };
    if (await accepted('code exchange with leading ?', advisoryId(`code:${flow.code}`), () => oauthPost('token', `?${form(fields)}`)) === 200) ran++;
    // The unprefixed forms are accepted on every runtime, so at least those ran under their lock.
    expect(ran).toBeGreaterThanOrEqual(2);
  });
  it('refuses conflicting repeats of the grant or the chosen field, before any lock or Better Auth', async () => {
    const a = await token();
    const user = advisoryId(`user:${alice.id}`);
    const flow = await authorize();
    const base = { client_id: a.clientId };
    const cases: [string, string, string][] = [
      ['token', 'revoke', `${form({ ...base, token: 'a' })}&token=b`],
      ['token', 'refresh_token', `${form({ ...base, grant_type: 'refresh_token', refresh_token: a.refresh_token })}&refresh_token=other`],
      ['token', 'code', `${form({ ...base, grant_type: 'authorization_code', code: flow.code! })}&code=other`],
      // The repeated grant would otherwise run an unlocked grant while another is locked for.
      ['token', 'grant_type', `${form({ ...base, grant_type: 'client_credentials' })}&grant_type=refresh_token&refresh_token=${a.refresh_token}`],
      ['token', 'grant_type last', `${form({ ...base, grant_type: 'refresh_token', refresh_token: a.refresh_token })}&grant_type=client_credentials`],
    ];
    for (const [path, label, body] of cases) {
      const { waits, response } = await holding(user, () => oauthPost(label === 'revoke' ? 'revoke' : path, body), 300);
      expect(waits, label).toBe(false);
      expect(response.status, label).toBe(400);
      expect((await response.json() as any).error, label).toBe('invalid_request');
    }
    // The token survived all of those.
    expect((await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token })).status).toBe(200);
  });
  it('parses lock targets the way Better Auth reads token and revoke bodies', async () => {
    const f = 'application/x-www-form-urlencoded';
    const body = (s: string) => Buffer.from(s);
    expect(await lockTarget('/oauth2/token', f, body('grant_type=refresh_token&refresh_token=R&token=T&code=C'))).toEqual({ token: 'R' });
    expect(await lockTarget('/oauth2/token', `${f}; charset=UTF-8`, body('grant_type=%20authorization_code%20&code=C&refresh_token=R'))).toEqual({ code: 'C' });
    expect(await lockTarget('/oauth2/token', f.toUpperCase(), body('grant_type=refresh_token&refresh_token=R'))).toEqual({ token: 'R' });
    expect(await lockTarget('/oauth2/revoke', f, body('refresh_token=R&token=Bearer%20T&grant_type=refresh_token'))).toEqual({ token: 'T' });
    expect(await lockTarget('/oauth2/token', f, body('refresh_token=R&grant_type=refresh_token&refresh_token=R'))).toEqual({ token: 'R' });
    expect(await lockTarget('/oauth2/token', f, body('grant_type=refresh_token&refresh_token=R&refresh_token=S'))).toEqual({ ambiguous: true });
    expect(await lockTarget('/oauth2/token', f, body('grant_type=refresh_token&grant_type=authorization_code'))).toEqual({ ambiguous: true });
    expect(await lockTarget('/oauth2/revoke', f, body('token=a&token=b'))).toEqual({ ambiguous: true });
    // grant_type repeats are compared after trimming, as Better Auth trims before dispatching.
    expect(await lockTarget('/oauth2/token', f, body('grant_type=refresh_token&grant_type=%20refresh_token%20&refresh_token=R'))).toEqual({ token: 'R' });
    expect(await lockTarget('/oauth2/token', f, body('grant_type=refresh_token&?refresh_token=R'))).toBeUndefined();
    for (const none of await Promise.all([
      lockTarget('/oauth2/token', f, body('grant_type=client_credentials&refresh_token=R&code=C')),
      lockTarget('/oauth2/token', f, body('refresh_token=R')),
      lockTarget('/oauth2/token', f, body('grant_type=refresh_token')),
      lockTarget('/oauth2/token', f, body('grant_type=refresh_token&refresh_token=')),
      lockTarget('/oauth2/token', f, body('grant_type=refresh_token&token=T')),
      lockTarget('/oauth2/revoke', f, body('refresh_token=R')),
      lockTarget('/oauth2/revoke', f, body('token=')),
      lockTarget('/oauth2/token', 'application/json', body('{"grant_type":"refresh_token","refresh_token":"R"}')),
      lockTarget('/oauth2/token', undefined, body('grant_type=refresh_token&refresh_token=R')),
      lockTarget('/oauth2/token', f, undefined),
    ])) expect(none).toBeUndefined();
  });
  it('serializes concurrent refreshes of one grant: exactly one wins', async () => {
    const a = await token();
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token })))).map(r => r.status);
    expect(statuses.sort()).toEqual([200, 400, 400, 400, 400, 400]);
    expect(await advisoryHeld()).toBe(0);
  });
  it('limits token and revoke requests per IP (IPv6 by /64) before any lookup or lock', async () => {
    const a = await token();
    const user = advisoryId(`user:${alice.id}`);
    await withReplica(await startReplica({ tokenRequestLimit: { rps: 0.001, burst: 3 }, lockWaitMs: 300 }), async () => {
      const post = (path: string, ip: string, fields: Record<string, string>) =>
        fetch(`${config.origin}/api/auth/oauth2/${path}`, { method: 'POST', headers: { 'x-real-ip': ip }, body: new URLSearchParams({ client_id: a.clientId, ...fields }) }).then(r => r.status);
      const refresh = (ip: string) => post('token', ip, { grant_type: 'refresh_token', refresh_token: 'unknown' });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push(await refresh('192.0.2.131'));
      expect(statuses.slice(3)).toEqual([429, 429, 429]);
      expect(statuses.slice(0, 3).every(x => x !== 429)).toBe(true);
      expect(await post('revoke', '192.0.2.131', { token: 'x' })).toBe(429);
      expect(await post('revoke', '192.0.2.132', { token: 'x' })).not.toBe(429);
      // Every address of one /64 shares a bucket, and an IPv4-mapped address is its IPv4.
      const v6 = ['2001:db8:1:2::1', '2001:db8:1:2:aaaa::2', '2001:DB8:1:2:0:0:0:3'];
      expect(await Promise.all(v6.map(ip => refresh(ip)))).not.toContain(429);
      expect(await refresh('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(429);
      expect(await refresh('2001:db8:1:3::1')).not.toBe(429);
      expect(await refresh('::ffff:192.0.2.131')).toBe(429);
      // Over budget is answered before the token lookup or the lock: a held user lock does not delay it.
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN'); await hold.query('SELECT pg_advisory_xact_lock($1)', [user]);
        const started = Date.now();
        expect(await post('token', '192.0.2.131', { grant_type: 'refresh_token', refresh_token: a.refresh_token })).toBe(429);
        expect(Date.now() - started).toBeLessThan(250);
      } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
    });
  });
  it('answers 503 with Retry-After, rolls back and releases the connection when a lock wait times out', async () => {
    const a = await token();
    const user = advisoryId(`user:${alice.id}`);
    await withReplica(await startReplica({ lockWaitMs: 300 }), async () => {
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN'); await hold.query('SELECT pg_advisory_xact_lock($1)', [user]);
        const started = Date.now();
        const waited = await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
        expect(waited.status).toBe(503);
        expect(waited.headers.get('retry-after')).toBe('5');
        expect((await waited.json() as any).error).toBe('temporarily_unavailable');
        expect(Date.now() - started).toBeLessThan(5000);
        // Nothing of the timed-out request is left in a transaction.
        const idle = await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid() AND pid<>$1", [(await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]);
        expect(Number(idle.rows[0].count)).toBe(0);
      } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
      // The released connection holds no lock, and the grant was not consumed: it still works.
      expect(await advisoryHeld()).toBe(0);
      const after = await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
      expect(after.status, await after.clone().text()).toBe(200);
    });
  });
  it('sizes the lock pool from AUTH_LOCK_POOL_SIZE and answers 503 when no lock connection frees up', async () => {
    const a = await token();
    const user = advisoryId(`user:${alice.id}`);
    await withReplica(await startReplica({ lockWaitMs: 1500 }, { authLockPoolSize: 2 }), async () => {
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN'); await hold.query('SELECT pg_advisory_xact_lock($1)', [user]);
        const refresh = () => exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
        const pending = [refresh(), refresh(), refresh(), refresh()];
        await new Promise(r => setTimeout(r, 500));
        // Two pool connections are parked on the lock; the other requests wait for a connection.
        const waiting = await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' AND pid<>pg_backend_pid()");
        expect(Number(waiting.rows[0].count)).toBe(2);
        const statuses = (await Promise.all(pending)).map(r => r.status);
        expect(statuses).toEqual([503, 503, 503, 503]);
      } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
      expect((await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token })).status).toBe(200);
    });
    expect(await advisoryHeld()).toBe(0);
  });
  // ---- Bearer token admission: tokens this server issues are `at1.…` and admitted by their MAC. ----
  /** What an empty POST gets once the token is admitted: the MCP transport refuses the missing content type. */
  const ADMITTED = 415;
  const mcpPost = (value: string, headers: Record<string, string> = {}) =>
    fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: `Bearer ${value}`, ...headers } });
  const bucketCount = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count as number | undefined;
  const revoke = (value: string, revoked: Date | null = new Date()) =>
    pool.query('UPDATE "oauthAccessToken" SET revoked=$2 WHERE token=$1', [digest(value), revoked]);
  const statusCounts = (statuses: number[]) =>
    Object.fromEntries([...new Set(statuses)].sort().map(s => [s, statuses.filter(x => x === s).length]));
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  /** Per-user and per-address counters accumulate across tests within a minute; tests that send hundreds start clean. */
  const resetLimits = () => pool.query('DELETE FROM request_limits');
  /**
   * A replica (cold admission cache) answering the requests, whose real `oauthAccessToken` lookups are counted.
   * `gate` may hold a lookup until the test releases it. Everything else is the real handler and the real database.
   */
  async function countingReplica<T>(
    tuning: Parameters<typeof createAccountApp>[5],
    run: (lookups: { count: number; of: string[] }) => Promise<T>,
    gate?: (digestOfToken: string) => Promise<void> | undefined,
  ) {
    await resetLimits();
    const replica = await startReplica(tuning);
    const lookups = { count: 0, of: [] as string[] };
    const { adapter } = await replica.auth.$context;
    const findOne = adapter.findOne.bind(adapter) as typeof adapter.findOne;
    adapter.findOne = (async (query: Parameters<typeof adapter.findOne>[0]) => {
      if (query.model === 'oauthAccessToken') {
        const value = String(query.where?.find(w => w.field === 'token')?.value);
        lookups.count++; lookups.of.push(value);
        // The result is read first and held afterwards, so a held check carries the state it saw.
        const result = await findOne(query);
        await gate?.(value);
        return result;
      }
      return findOne(query);
    }) as typeof adapter.findOne;
    return withReplica(replica, () => run(lookups));
  }
  /** A fresh, valid, MAC-valid token for alice. */
  const freshToken = async () => (await validTokens((await token()).access_token, 1))[0]!;

  it('issues tokens in the authenticated format, stored as a digest of the whole token', async () => {
    const issued = await token();
    expect(issued.access_token).toMatch(/^at1\.a\.[0-9a-z]+\.[\w-]{32}\.[\w-]{22}$/);
    expect(accessTokens.parse(issued.access_token)).toBeTruthy();
    // Both the signature key and the format are this server's own.
    expect(new AccessTokenFormat(config.authSecret).parse(issued.access_token)).toBeTruthy();
    expect(new AccessTokenFormat(randomToken()).parse(issued.access_token)).toBeUndefined();
    const rows = (await pool.query('SELECT "referenceId" FROM "oauthAccessToken" WHERE token=$1', [digest(issued.access_token)])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].referenceId).toBe('personal');
  });

  it('junk in the authenticated format is refused before any database work, then a valid token passes', async () => {
    const good = accessTokens.generate();
    const [, , iat, random, mac] = good.split('.') as [string, string, string, string, string];
    const other = new AccessTokenFormat(randomToken()).generate();
    const junk = [
      () => `at1.a.${iat}.${randomToken().slice(0, 32)}.${randomToken().slice(0, 22)}`,
      () => `at1.a.${iat}.${random}.${randomToken().slice(0, 22)}`,
      () => `at1.b.${iat}.${random}.${mac}`,
      () => `at1.a.${iat}.${random}!.${mac}`,
      () => `at1.a.${iat}.${random}.${mac}.extra`,
      () => `at1.${'x'.repeat(3000)}`,
      () => `at1.${'x'.repeat(4000)}`,
      // Past the 4096-character header cap the request never reaches the admission at all.
      () => `at1.${'x'.repeat(5000)}`,
      () => other,
      () => accessTokens.generate().replace(/.$/, c => (c === 'A' ? 'B' : 'A')),
    ];
    const valid = await freshToken();
    await countingReplica({}, async lookups => {
      const before = await bucketCount('mcp-ip:192.0.2.150');
      const statuses: number[] = [];
      for (let wave = 0; wave < 100; wave++)
        statuses.push(...await Promise.all(Array.from({ length: 100 }, (_, i) => rawPost(junk[(wave + i) % junk.length]!(), '192.0.2.150'))));
      expect(statuses).toHaveLength(10_000);
      expect(statusCounts(statuses)).toEqual({ 401: 10_000 });
      expect(lookups.count, 'junk made no adapter call').toBe(0);
      expect(await bucketCount('mcp-ip:192.0.2.150'), 'and spent no flood allowance').toBe(before);
      expect((await mcpPost(valid, { 'x-real-ip': '192.0.2.150' })).status).toBe(ADMITTED);
      expect(lookups.count).toBe(1);
    });
  });

  it('a revoked real token replayed past the old burst costs one lookup, sequentially and 256-way', async () => {
    const [sequential, concurrent] = await validTokens((await token()).access_token, 2) as [string, string];
    const stranger = await freshToken();
    await revoke(sequential); await revoke(concurrent);
    await countingReplica({}, async lookups => {
      const ip = { 'x-real-ip': '192.0.2.151' };
      for (let i = 0; i < 150; i++) expect((await mcpPost(sequential, ip)).status).toBe(401);
      expect(lookups.of.filter(d => d === digest(sequential))).toHaveLength(1);
      expect((await mcpPost(stranger, ip)).status).toBe(ADMITTED);
    });
    // Cold cache, 256 at once. The first lookup is held until the first 32 requests (the agent's socket
    // limit) have been received.
    let received = 0;
    let enough!: () => void;
    const arrived = new Promise<void>(resolve => (enough = resolve));
    const count = () => { if (++received === 32) enough(); };
    server.on('request', count);
    try {
      await countingReplica({}, async lookups => {
        const statuses = await Promise.all(Array.from({ length: 256 }, () => rawPost(concurrent, '192.0.2.152')));
        expect(lookups.of.filter(d => d === digest(concurrent))).toHaveLength(1);
        // The owner and its waiters answer 401; requests that arrive later hit the remembered rejection.
        expect(statuses.every(s => s === 401 || s === 429), JSON.stringify(statusCounts(statuses))).toBe(true);
        expect(statuses.filter(s => s === 401).length).toBeGreaterThanOrEqual(9);
        // The shared address is not locked out: a different valid token is served, and the replay stays free.
        expect(await rawPost(stranger, '192.0.2.152')).toBe(ADMITTED);
        expect(await rawPost(concurrent, '192.0.2.152')).toBe(401);
        expect(lookups.of.filter(d => d === digest(concurrent))).toHaveLength(1);
      }, () => arrived.then(settle));
    } finally {
      server.removeListener('request', count);
    }
  });

  it('the maximum-age bound, fixed negative TTL and the skew window follow the admission deadline', async () => {
    const early = (await token()).access_token;
    // Issuance and admission share the injected clock, three hours ahead of the real one.
    const base = 3 * 3600_000;
    let offset = base;
    const ip = { 'x-real-ip': '192.0.2.153' };
    await countingReplica({ now: () => Date.now() + offset }, async lookups => {
      const value = (await token()).access_token;
      expect(Math.abs(accessTokens.parse(value)!.iat - (Date.now() + base) / 1000), 'the issue time comes from the injected clock').toBeLessThan(60);
      const count = () => lookups.of.filter(d => d === digest(value)).length;
      // The database says expired, but the token is still inside the 60 s skew window: one lookup, remembered.
      await pool.query('UPDATE "oauthAccessToken" SET "expiresAt"=$2 WHERE token=$1', [digest(value), new Date(0)]);
      offset = base + (900 + 30) * 1000;
      expect((await mcpPost(value, ip)).status).toBe(401);
      expect((await mcpPost(value, ip)).status).toBe(401);
      expect(count()).toBe(1);
      // Past iat + lifetime + skew nothing reaches the database, cached or not.
      offset = base + (900 + 61) * 1000;
      expect((await mcpPost(value, ip)).status).toBe(401);
      expect(count()).toBe(1);
    });
    // An expired real token on a cold cache: no adapter call at all.
    await countingReplica({ now: () => Date.now() + 2 * 3600_000 }, async lookups => {
      expect((await mcpPost(early, ip)).status).toBe(401);
      expect(lookups.count).toBe(0);
    });
  });

  it('revocation applies on the very next request; a restored client is accepted within 60 s', async () => {
    let offset = 0;
    const [revoked, enabled] = await validTokens((await token()).access_token, 2) as [string, string];
    const clientId = (await pool.query('SELECT "clientId" FROM "oauthAccessToken" WHERE token=$1', [digest(revoked)])).rows[0].clientId as string;
    const setDisabled = (disabled: boolean) => pool.query('UPDATE "oauthClient" SET disabled=$2 WHERE "clientId"=$1', [clientId, disabled]);
    const ip = { 'x-real-ip': '192.0.2.154' };
    await countingReplica({ now: () => Date.now() + offset }, async lookups => {
      expect((await mcpPost(revoked, ip)).status).toBe(ADMITTED);
      await revoke(revoked);
      expect((await mcpPost(revoked, ip)).status, 'revocation is not delayed').toBe(401);
      expect((await mcpPost(enabled, ip)).status).toBe(ADMITTED);
      await setDisabled(true);
      try { expect((await mcpPost(enabled, ip)).status).toBe(401); }
      finally { await setDisabled(false); }
      const seen = lookups.count;
      // Restored, but the rejection is remembered for its fixed 60 s: no lookup, still refused...
      expect((await mcpPost(enabled, ip)).status).toBe(401);
      expect(lookups.count).toBe(seen);
      offset = 59_000;
      expect((await mcpPost(enabled, ip)).status).toBe(401);
      // ...and accepted once it has expired, however often it was hit meanwhile.
      offset = 61_000;
      expect((await mcpPost(enabled, ip)).status).toBe(ADMITTED);
    });
  });

  it('a first-use burst of 64 with a brand-new valid token is fully served, each with its own check', async () => {
    const value = await freshToken();
    await countingReplica({}, async lookups => {
      const statuses = await Promise.all(Array.from({ length: 64 }, () => rawPost(value, '192.0.2.155')));
      expect(statusCounts(statuses)).toEqual({ [ADMITTED]: 64 });
      expect(lookups.of.filter(d => d === digest(value))).toHaveLength(64);
    });
  });

  it('a warmed, then revoked token cannot take the shared slots: 16 checks at most, others queue, and other users are served meanwhile', async () => {
    const value = await freshToken();
    const stranger = await freshToken();
    const ip = '192.0.2.156';
    let holding = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    try {
      await countingReplica({ maxTokenChecksInFlight: 20 }, async lookups => {
        try {
          const mine = () => lookups.of.filter(d => d === digest(value)).length;
          expect(await rawPost(value, ip)).toBe(ADMITTED);
          expect(mine()).toBe(1);
          await revoke(value);
          holding = true;
          const burst = Array.from({ length: 256 }, () => rawPost(value, ip));
          while (mine() < 1 + 16) await settle();
          // Sixteen checks are pending and hold slots; the other requests queue without holding any.
          // A different valid token on the same address is served while they are still pending.
          // (A separate connection pool: the burst's agent has all of its sockets busy.)
          expect((await mcpPost(stranger, { 'x-real-ip': ip })).status).toBe(ADMITTED);
          expect(mine()).toBe(1 + 16);
          holding = false;
          release();
          const statuses = await Promise.all(burst);
          expect(statuses.every(s => s === 401 || s === 429), JSON.stringify(statusCounts(statuses))).toBe(true);
          // The first rejection answers the queued requests; the replay stays free afterwards.
          expect(mine()).toBe(1 + 16);
          for (let i = 0; i < 20; i++) expect(await rawPost(value, ip)).toBe(401);
          expect(mine()).toBe(1 + 16);
          expect(await rawPost(stranger, ip)).toBe(ADMITTED);
        } finally {
          // Release before the replica is torn down: a held lookup must not outlive the test body.
          holding = false;
          release();
        }
      }, digestOfToken => (holding && digestOfToken === digest(value) ? held : undefined));
    } finally {
      holding = false;
      release();
    }
  });

  it('a stale overlapping rejection does not renew the negative entry: restored access is admitted 61 s after the first rejection', async () => {
    let offset = 0;
    const value = await freshToken();
    const ip = '192.0.2.157';
    const holds: Array<() => void> = [];
    let holding = false;
    try {
      await countingReplica({ now: () => Date.now() + offset }, async lookups => {
        const mine = () => lookups.of.filter(d => d === digest(value)).length;
        expect(await rawPost(value, ip)).toBe(ADMITTED);
        await revoke(value);
        try {
          // Two checks overlap; both read the revoked row (held after the read).
          holding = true;
          const first = rawPost(value, ip);
          const second = rawPost(value, ip);
          while (holds.length < 2) await settle();
          holding = false;
          // Either request may reach the database first, so release whichever is held first and wait for
          // whichever finishes first (a rejection), never for a particular one.
          holds[0]!();
          const [firstStatus, firstDone] = await Promise.race([
            first.then(status => [status, 'first'] as const),
            second.then(status => [status, 'second'] as const),
          ]);
          expect(firstStatus).toBe(401);
          await revoke(value, null);
          offset = 30_000;
          holds[1]!();
          expect(await (firstDone === 'first' ? second : first)).toBe(401);
          const seen = mine();
          offset = 61_000;
          expect(await rawPost(value, ip), 'admitted again 61 s after the first rejection').toBe(ADMITTED);
          expect(mine()).toBe(seen + 1);
        } finally {
          holding = false;
          for (const hold of holds) hold();
          await revoke(value, null);
        }
      }, digestOfToken => (holding && digestOfToken === digest(value) ? new Promise<void>(resolve => holds.push(resolve)) : undefined));
    } finally {
      holding = false;
      for (const hold of holds) hold();
    }
  });

  it('refuses bearer tokens outside the authenticated format before any lookup or shared budget, including a stored legacy token', async () => {
    const [legacy] = await validTokens((await token()).access_token, 1, () => randomToken()) as [string];
    await countingReplica({}, async lookups => {
      expect(await bucketCount('mcp-ip:192.0.2.160')).toBeUndefined();
      const shapes = [legacy, randomToken(), 'nope', 'AT1.a.1.2.3', 'at1', 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln', 'x'.repeat(4000)];
      for (const value of shapes) {
        const response = await mcpPost(value, { 'x-real-ip': '192.0.2.160' });
        expect(response.status, value.slice(0, 12)).toBe(401);
        expect(response.headers.get('www-authenticate'), value.slice(0, 12)).toContain('error="invalid_token"');
      }
      // The real database row of the legacy token is never read, and nothing counted against the address.
      expect(lookups.count).toBe(0);
      expect(await bucketCount('mcp-ip:192.0.2.160')).toBeUndefined();
    });
  });

  it('a legacy-shaped flood never touches the shared flood counter, the in-flight slots or at1 callers', async () => {
    const at1 = await validTokens((await token()).access_token, 20);
    const ip = '192.0.2.161';
    // Two slots, used one at a time by the at1 callers: if junk took any, they would be refused with 429.
    await countingReplica({ maxTokenChecksInFlight: 2 }, async lookups => {
      const flood = Promise.all(Array.from({ length: 1000 }, () => rawPost(randomToken(), ip)));
      const served: number[] = [];
      try {
        for (const value of at1) served.push(await rawPost(value, ip));
      } finally {
        // Settle the flood before any assertion can throw, so no request outlives the replica.
        await flood.catch(() => undefined);
      }
      expect(statusCounts(served)).toEqual({ [ADMITTED]: 20 });
      expect(statusCounts(await flood)).toEqual({ 401: 1000 });
      expect(lookups.of.sort()).toEqual(at1.map(digest).sort());
      expect(await bucketCount(`mcp-ip:${ip}`)).toBe(20);
    });
  });

  it('in-flight bearer checks are capped per IPv6 /64 in aggregate and counters are cleaned up', async () => {
    const issued = (await token()).access_token;
    // Distinct digests: the per-token duplicate suppression is separate from the per-address cap.
    const valid = await validTokens(issued, 180);
    const forgedValid = Array.from({ length: 60 }, () => accessTokens.generate());
    const CAP = 20;
    const post = (value: string, ip: string) => mcpPost(value, { 'x-real-ip': ip }).then(r => r.status);
    const settledWhileBlocked = async (tokens: string[], prefix: string, total: number) => {
      // A held table lock stalls every bearer check inside the counted section.
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN');
        await hold.query('LOCK TABLE request_limits IN ACCESS EXCLUSIVE MODE');
        let immediate = 0;
        const all = Array.from({ length: total }, (_, i) => post(tokens[i]!, `${prefix}::${(i % 6) + 1}`).then(status => { immediate++; return status; }));
        await new Promise(resolve => setTimeout(resolve, 600));
        const refused = immediate;
        await hold.query('ROLLBACK');
        const statuses = await Promise.all(all);
        // Admitted checks spent the per-user quota too; start each round fresh.
        await pool.query('DELETE FROM request_limits');
        return { refused, statuses };
      } finally {
        await hold.query('ROLLBACK').catch(() => undefined);
        hold.release();
      }
    };
    await withReplica(await startReplica({ maxTokenChecksInFlight: CAP }), async () => {
      // 60 checks over six addresses of one /64: 20 are admitted in aggregate, 40 refused at once.
      expect((await settledWhileBlocked(valid.slice(0, 60), '2001:db8:aaaa:1', 60)).refused).toBe(40);
      // After success the counters are back to zero: the same cap applies again, not a smaller one.
      expect((await settledWhileBlocked(valid.slice(60, 120), '2001:db8:aaaa:1', 60)).refused).toBe(40);
      // After rejections too: 15 MAC-valid but unknown tokens are admitted, rejected and released.
      const forged = await settledWhileBlocked(forgedValid, '2001:db8:aaaa:2', 15);
      expect(forged.refused).toBe(0);
      expect(forged.statuses.every(s => s === 401)).toBe(true);
      expect((await settledWhileBlocked(valid.slice(120), '2001:db8:aaaa:2', 60)).refused).toBe(40);
    });
    // After exceptions: a replica whose database is gone answers 500 and must not leak counts.
    const brokenPool = new Pool({ ...pool.options });
    const broken = await startReplica({ maxTokenChecksInFlight: CAP }, undefined, new Store(brokenPool, new Keyring('v1', { v1: randomBytes(32) })));
    await brokenPool.end();
    await withReplica(broken, async () => {
      const statuses: number[] = [];
      for (let wave = 0; wave < 8; wave++)
        statuses.push(...await Promise.all(Array.from({ length: 10 }, (_, i) => post(accessTokens.generate(), `2001:db8:aaaa:3::${i + 1}`))));
      expect(new Set(statuses)).toEqual(new Set([500]));
    });
  });

  it('the real Better Auth handler issues, refreshes, introspects and revokes at1 tokens and keeps referenceId', async () => {
    const issued = await confidentialToken();
    const row = (await pool.query('SELECT * FROM "oauthAccessToken" WHERE token=$1', [digest(issued.access_token)])).rows[0];
    expect(row, 'the complete token is stored as its digest').toBeTruthy();
    expect(row.referenceId).toBe('personal');
    const introspect = async (value: string) => {
      const response = await fetch(`${config.origin}/api/auth/oauth2/introspect`, {
        method: 'POST', body: new URLSearchParams({ client_id: issued.clientId, client_secret: issued.secret, token: value, token_type_hint: 'access_token' }),
      });
      return { status: response.status, body: await response.json() as any };
    };
    const refreshed = await (await exchange(issued.clientId, { grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_secret: issued.secret })).json() as any;
    expect(accessTokens.parse(refreshed.access_token)).toBeTruthy();
    expect((await mcpPost(refreshed.access_token)).status).toBe(ADMITTED);
    const refreshedRow = (await pool.query('SELECT "referenceId" FROM "oauthAccessToken" WHERE token=$1', [digest(refreshed.access_token)])).rows[0];
    expect(refreshedRow.referenceId).toBe('personal');
    expect(await introspect(refreshed.access_token)).toMatchObject({ body: { active: true } });
    // A Bearer-prefixed revoke takes the user lock chosen from the at1 token, then revokes it.
    const { waits, response } = await holding(advisoryId(`user:${alice.id}`), () => oauthPost('revoke', form({
      client_id: issued.clientId, client_secret: issued.secret, token: `Bearer ${refreshed.access_token}`, token_type_hint: 'access_token',
    })));
    expect(waits, 'the revoke queued on the user lock').toBe(true);
    expect(response.status).toBe(200);
    expect((await mcpPost(refreshed.access_token)).status).toBe(401);
    expect((await introspect(refreshed.access_token)).body).toMatchObject({ active: false });
  });

  it('the OIDC userinfo route, the only other route that takes an access token as a bearer, treats at1 and legacy tokens alike', async () => {
    const [at1] = await validTokens((await token()).access_token, 1) as [string];
    const [legacy] = await validTokens(at1, 1, () => randomToken()) as [string];
    const userinfo = async (value: string) => {
      const response = await fetch(`${config.origin}/api/auth/oauth2/userinfo`, { headers: { authorization: `Bearer ${value}` } });
      return { status: response.status, body: await response.json().catch(() => undefined) as any };
    };
    const forAt1 = await userinfo(at1);
    expect(forAt1.status, JSON.stringify(forAt1.body)).toBeLessThan(500);
    // Same answer for both shapes (the grant has no openid scope, so it is refused for the same reason),
    // and neither goes through the /mcp/account admission: no flood counter, no negative-cache entry.
    expect(await userinfo(legacy)).toEqual(forAt1);
    expect((await userinfo(accessTokens.generate())).status).toBeGreaterThanOrEqual(400);
    expect((await mcpPost(at1)).status).toBe(ADMITTED);
  });

  it('other bearer values are untouched by the at1 checks: the anonymous endpoint ignores them, with no lookup', async () => {
    const value = await freshToken();
    const post = (path: string, bearer: string) => fetch(`${config.origin}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'x-real-ip': '192.0.2.170', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }).then(r => r.status);
    await countingReplica({}, async lookups => {
      const before = await bucketCount('mcp-ip:192.0.2.170');
      // A valid at1 token, a made-up at1 value, a JWT-shaped value and a legacy-shaped one are all ignored at /mcp.
      for (const bearer of [value, accessTokens.generate(), `at1.${'x'.repeat(4000)}`, 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln', randomToken()])
        expect(await post('/mcp', bearer), bearer.slice(0, 20)).toBe(200);
      expect(lookups.count).toBe(0);
      expect(await bucketCount('mcp-ip:192.0.2.170')).toBe(before);
    });
  });
  it('reads AUTH_LOCK_POOL_SIZE as an integer from 2 to 200, default unset', () => {
    const env = { USPTO_PUBLIC_ORIGIN: 'https://example.com', BETTER_AUTH_SECRET: 's'.repeat(32), ENCRYPTION_KEYS_JSON: JSON.stringify({ k: randomBytes(32).toString('base64') }),
      ENCRYPTION_ACTIVE_KEY_ID: 'k', DATABASE_URL: 'postgresql://x', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };
    expect(loadAccountConfig(env).authLockPoolSize).toBeUndefined();
    expect(loadAccountConfig({ ...env, AUTH_LOCK_POOL_SIZE: ' 25 ' }).authLockPoolSize).toBe(25);
    for (const bad of ['1', '201', '2.5', 'abc', '-3']) expect(() => loadAccountConfig({ ...env, AUTH_LOCK_POOL_SIZE: bad }), bad).toThrow(/AUTH_LOCK_POOL_SIZE/);
  });

});
