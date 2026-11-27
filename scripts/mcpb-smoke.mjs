#!/usr/bin/env node
// Smoke-tests an unpacked MCPB bundle the way a desktop host runs it: plain `node dist/bin.js`
// over stdio from the bundle directory, with a minimal environment, then `execute('return 42')`.
// The request is the modern MCP 2026-07-28 shape (stateless: no handshake, the `_meta` envelope on
// every request). A stdio connection serves one era, set by its first message, so the legacy
// `initialize` fallback is checked over HTTP (CI's Docker smoke and test/http-integration.spec.ts).
//
//   node scripts/mcpb-smoke.mjs <unpacked-bundle-dir>
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { executeProblems } from './smoke-result.mjs';

const dir = resolve(process.argv[2] ?? 'mcpb-build');
const child = spawn(process.execPath, ['dist/bin.js'], {
  cwd: dir, stdio: ['pipe', 'pipe', 'inherit'],
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
});
const REVISION = '2026-07-28';
const meta = () => ({
  'io.modelcontextprotocol/protocolVersion': REVISION,
  'io.modelcontextprotocol/clientInfo': { name: 'mcpb-smoke', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});
const send = m => child.stdin.write(JSON.stringify(m) + '\n');
let buf = '';
const timer = setTimeout(() => { console.error('mcpb smoke: timed out'); child.kill(); process.exit(1); }, 30_000);
child.stdout.on('data', chunk => {
  buf += chunk;
  for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      clearTimeout(timer);
      const problems = executeProblems(msg, 1, 42);
      if (problems.length === 0) console.log('mcpb smoke: execute returned 42 (2026-07-28 request)');
      else console.error(`mcpb smoke: ${problems.join('; ')}\n${line.slice(0, 500)}`);
      child.kill();
      process.exit(problems.length === 0 ? 0 : 1);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { code: 'return 1 + 41' }, _meta: meta() } });
