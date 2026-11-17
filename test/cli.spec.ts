import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { IsolateRunner } from '../src/sandbox/isolate.js';

const bin = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', ...args], { encoding: 'utf8', timeout: 20_000, input: '' });

describe('command line', () => {
  // A mistyped --http would otherwise start the stdio transport and wait on stdin without a word.
  it('refuses an option it does not know', () => {
    const r = bin('--htpp', '--insecure');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown option '--htpp'");
    expect(r.stdout).toBe('');
  });

  it('prints help and exits 0', () => {
    const r = bin('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--sandbox auto|isolate|deno');
    // `pnpm dev -- --help` hands the separator on.
    expect(bin('--', '--help').status).toBe(0);
  });

  // The default User-Agent is what USPTO sees of a deployment: it must name the real release.
  it('names its release to USPTO in the default User-Agent', async ({ skip }) => {
    if (!(await new IsolateRunner().available())) return skip();
    const seen: Array<string | undefined> = [];
    const upstream = createServer((req, res) => {
      seen.push(req.headers['user-agent']);
      res.setHeader('content-type', 'application/json').end('{"count":0}');
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const client = new Client({ name: 'cli-spec', version: '0.0.0' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/bin.ts', '--sandbox', 'isolate'],
        env: { PATH: process.env.PATH ?? '', USPTO_API_KEY: 'k'.repeat(32), USPTO_ODP_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` },
        stderr: 'ignore',
      }));
      const res = await client.callTool({ name: 'execute', arguments: { code: "return await odp.patents.metaData('17248024')" } });
      expect(res.isError ?? false).toBe(false);
      const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
      expect(seen).toEqual([`uspto-mcp-server/${version} (+https://github.com/blen-labs/uspto-mcp-server)`]);
    } finally {
      await client.close();
      await new Promise(r => upstream.close(r));
    }
  });
});
