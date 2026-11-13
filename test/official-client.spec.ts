import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAgent } from 'undici';
import {
  Client,
  StreamableHTTPClientTransport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { startHttp, type HttpHandle } from '../src/server/http.js';
import { MCP_PROTOCOL_VERSION } from '../src/server/mcpServer.js';
import { buildSdk } from '../src/sdk/bindings.js';
import { getSources } from '../src/sdk/sources/index.js';
import { buildCorpus } from '../src/search/corpus.js';
import { pickSandbox } from '../src/sandbox/index.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';
import { SubjectQuota } from '../src/util/quotas.js';
import { sourceCfg, ODP_ORIGIN } from './helpers.js';
import { expectToolMetadata } from './tool-metadata.js';

/**
 * Drives the server with the OFFICIAL MCP client SDK rather than hand-built requests.
 * The client constructs the `_meta` envelope and the Mcp-Method/Mcp-Name routing headers
 * itself, so this catches protocol mistakes that a hand-rolled request would encode
 * identically on both sides and therefore never surface.
 */

// No upstream call is expected here (search_api is corpus-local), so the dispatcher is
// wired purely to enforce that: `disableNetConnect` turns any accidental egress a future
// case adds into a MockAgent error instead of a silent real request to a .gov host.
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();

const SOURCES = sourceCfg({ odpKey: 'official-client-test-key-0123456789', dispatcher: mockAgent });

let handle: HttpHandle;
let url: URL;

let sandbox: Awaited<ReturnType<typeof pickSandbox>>;

beforeAll(async () => {
  sandbox = await pickSandbox('auto');
  const deps: CatalogDeps = {
    sdk: buildSdk(SOURCES),
    sandbox,
    corpus: buildCorpus(getSources(SOURCES)),
    callBudgets: { odp: 50, tsdr: 25 },
    subjectQuotas: { odp: new SubjectQuota(1_000_000, 3_600_000) },
  };
  handle = await startHttp(deps, {
    host: '127.0.0.1', port: 0, rps: 1000, burst: 1000,
    subjectDailyQuota: 1_000_000, insecure: true,
    auth: { provider: 'none' }, publicOrigin: 'http://127.0.0.1',
  });
  url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
});

afterAll(async () => { await handle.close(); });

// Typed, NOT `as never`: `versionNegotiation` is a real `ClientOptions` field, and casting
// the options object away meant a malformed mode (e.g. `{ mode: 'pin', pin: '…' }`, which
// is not a `VersionNegotiationMode`) compiled fine and silently fell back to legacy
// negotiation — leaving the "pins the modern revision" test passing without pinning.
async function connect(versionNegotiation: VersionNegotiationOptions) {
  const client = new Client(
    { name: 'uspto-conformance-probe', version: '1.0.0' },
    { versionNegotiation },
  );
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

describe('official MCP client SDK', () => {
  it('negotiates 2026-07-28 automatically and round-trips a tool call', async () => {
    const client = await connect({ mode: 'auto' });
    try {
      const listed = await client.listTools();
      expectToolMetadata(listed.tools);
      expect(listed.tools.map(t => t.name).sort())
        .toEqual(['describe_schema', 'execute', 'search_api']);
      // Cache metadata the 2026-07-28 revision requires on list results.
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe('public');

      const called = await client.callTool({
        name: 'search_api',
        arguments: { query: 'patent application search', k: 2 },
      });
      const text = (called.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect((JSON.parse(text) as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('runs execute end to end: sandbox -> odp SDK -> (mocked) api.uspto.gov', async ({ skip }) => {
    if (!(await sandbox.available())) return skip();
    mockAgent.get(ODP_ORIGIN).intercept({
      path: '/api/v1/patent/applications/search', method: 'POST',
      headers: { 'x-api-key': 'official-client-test-key-0123456789' },
      body: JSON.stringify({ q: 'battery', fields: ['applicationNumberText'], pagination: { offset: 0, limit: 2 } }),
    }).reply(200, { count: 7, patentFileWrapperDataBag: [{ applicationNumberText: '17248024' }, { applicationNumberText: '17248025' }] });
    const client = await connect({ mode: 'auto' });
    try {
      const called = await client.callTool({
        name: 'execute',
        arguments: { code: "const r = await odp.patents.search({ q: 'battery', fields: ['applicationNumberText'], limit: 2 }); return { total: r.count, apps: r.patentFileWrapperDataBag.map(p => p.applicationNumberText) };" },
      });
      const text = (called.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(JSON.parse(text)).toMatchObject({ ok: true, value: { total: 7, apps: ['17248024', '17248025'] } });
      expect(text).not.toContain('official-client-test-key');
    } finally {
      await client.close();
    }
  });

  it('returns structuredContent, and isError with the full envelope for a failed execution', async ({ skip }) => {
    if (!(await sandbox.available())) return skip();
    const client = await connect({ mode: 'auto' });
    try {
      const ok = await client.callTool({ name: 'execute', arguments: { code: 'return { a: 1 }' } });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ ok: true, value: { a: 1 } });
      const failed = await client.callTool({ name: 'execute', arguments: { code: 'console.log("before"); throw new Error("boom")' } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ ok: false, logs: ['before'], error: { name: 'Error', message: 'boom' } });
      const text = (failed.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: { message: 'boom' } });
      expect(text).not.toContain('\n  '); // compact JSON
      const listed = await client.listTools();
      const exec = listed.tools.find(t => t.name === 'execute')!;
      expect(exec.inputSchema.properties?.timeoutMs).toMatchObject({ type: 'integer', minimum: 100, maximum: 120000 });
      expect(exec.outputSchema).toMatchObject({ type: 'object', required: ['ok', 'logs', 'durationMs'] });
      const ds = listed.tools.find(t => t.name === 'describe_schema')!;
      expect(JSON.stringify(ds.inputSchema)).toContain('oneOf');
    } finally {
      await client.close();
    }
  });

  it('works when the client pins the modern revision explicitly', async () => {
    const client = await connect({ mode: { pin: MCP_PROTOCOL_VERSION } });
    try {
      const listed = await client.listTools();
      expectToolMetadata(listed.tools);
      expect(listed.tools).toHaveLength(3);
      // Assert something only the modern leg produces, so a pin that silently degraded to
      // legacy negotiation fails here instead of passing on the tool count alone.
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe('public');
    } finally {
      await client.close();
    }
  });
});
