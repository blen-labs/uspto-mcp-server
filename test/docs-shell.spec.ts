import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fencedBlocks } from '../scripts/check-fences.mjs';
import { claudeCodeCommand } from '../site/src/lib/install';

// The shell templates in the docs are run as written, with `npx` and `claude` replaced by stubs
// that record what they were called with. A template that the shell breaks before it reaches the
// command (an unquoted `<placeholder>` is read as redirection) never calls the stub. No network.
const root = resolve(__dirname, '..');
const stubbed = ['npx', 'claude'];

interface Call { command: string; args: string[]; env: Record<string, string> }

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docs-shell-'));
  const record = join(dir, 'calls.jsonl');
  for (const name of stubbed) {
    const stub = join(dir, name);
    writeFileSync(stub, `#!/bin/sh\nnode -e 'const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("USPTO_")));\nrequire("fs").appendFileSync(process.argv[1], JSON.stringify({ command: "${name}", args: process.argv.slice(2), env: e }) + "\\n")' "${record}" "$@"\n`);
    chmodSync(stub, 0o755);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (script: string): { status: number | null; stderr: string; calls: Call[] } => {
  const record = join(dir, 'calls.jsonl');
  rmSync(record, { force: true });
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  let calls: Call[] = [];
  try { calls = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Call); } catch { /* the script never reached a stub */ }
  return { status: r.status, stderr: r.stderr, calls };
};

const bashBlocks = (file: string) =>
  fencedBlocks(readFileSync(resolve(root, file), 'utf8')).filter(b => b.info === 'bash' && /\b(npx|claude)\b/.test(b.body));
const invocations = (body: string) => body.split('\n').filter(l => !l.trim().startsWith('#')).join('\n').match(/\b(npx|claude) /g)?.length ?? 0;

describe.each(['README.md', 'site/src/content/docs/self-host.mdx'])('shell templates in %s', file => {
  const blocks = bashBlocks(file);

  it('has templates to check', () => expect(blocks.length).toBeGreaterThan(0));

  it.each(blocks.map(b => [`line ${b.line}`, b.body] as const))('%s reaches every invocation', (_where, body) => {
    const { status, stderr, calls } = run(body);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(calls).toHaveLength(invocations(body));
    for (const call of calls) {
      expect(call.args[0]).toBe('@blen/uspto-mcp-server');
      for (const name of ['USPTO_AUTH_ISSUER', 'USPTO_AUTH_AUDIENCE', 'USPTO_AUTH_JWKS_URL', 'USPTO_PUBLIC_ORIGIN']) {
        if (call.env[name]) expect(() => new URL(call.env[name]!), name).not.toThrow();
      }
    }
  });
});

describe('the OIDC template', () => {
  it.each(['README.md', 'site/src/content/docs/self-host.mdx'])('in %s passes the issuer, audience, JWKS URL and origin as whole URLs', file => {
    const body = bashBlocks(file).find(b => b.body.includes('USPTO_AUTH_PROVIDER'))!.body;
    const call = run(body).calls.at(-1)!;
    expect(call.env).toMatchObject({
      USPTO_AUTH_PROVIDER: 'clerk',
      USPTO_AUTH_ISSUER: 'https://your-tenant.clerk.accounts.dev',
      USPTO_AUTH_AUDIENCE: 'https://your-host.example.com/mcp',
      USPTO_AUTH_JWKS_URL: 'https://your-tenant.clerk.accounts.dev/.well-known/jwks.json',
      USPTO_PUBLIC_ORIGIN: 'https://your-host.example.com',
    });
  });
});

describe('the Claude Code command on the connect page', () => {
  it('registers the server with both keys', () => {
    const { status, calls } = run(claudeCodeCommand);
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['mcp', 'add', 'uspto', '-e', 'USPTO_API_KEY=your-odp-key', '-e', 'USPTO_TSDR_API_KEY=your-tsdr-key', '--', 'npx', '-y', '@blen/uspto-mcp-server']);
  });
});

describe('the template check itself', () => {
  it('fails when the shell reads a placeholder as redirection', () => {
    const { status, calls } = run('USPTO_AUTH_ISSUER=https://<tenant>.example.com npx @blen/uspto-mcp-server --http');
    expect(status).not.toBe(0);
    expect(calls).toEqual([]);
  });
});
