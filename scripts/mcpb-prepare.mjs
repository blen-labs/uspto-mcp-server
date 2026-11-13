#!/usr/bin/env node
// Stages an MCPB (MCP Bundle) directory for `mcpb pack mcpb-build`.
// Run from the repo root, after `pnpm build`:  pnpm build && pnpm mcpb:prepare
import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/**
 * The MCPB manifest, shaped for @anthropic-ai/mcpb's v0.1 schema
 * (required: name, version, description, author, server — the entry point
 * lives inside `server`, not at the top level).
 */
export function buildManifest(pkg) {
  return {
    manifest_version: '0.4',
    name: 'uspto-mcp-server',
    display_name: 'Patents & Trademarks MCP',
    version: pkg.version,
    description:
      'Code-mode MCP server for the USPTO Open Data Portal (patents, PTAB, petitions, office actions, bulk datasets) and TSDR trademark status, via odp.* and tsdr.* SDK bindings.',
    long_description:
      'Ask about patent applications and grants, PTAB trials and appeals, petition decisions, office actions, bulk datasets and trademark status. ' +
      'The assistant writes small JavaScript programs that run in a sandbox (isolated-vm, or Deno) against the USPTO APIs with your own API keys, ' +
      'which stay on your computer. Independent open-source project; not affiliated with or endorsed by the USPTO.',
    author: { name: 'BLEN, Inc.', url: 'https://blenlabs.com' },
    repository: { type: 'git', url: 'https://github.com/blen-labs/uspto-mcp-server' },
    homepage: 'https://github.com/blen-labs/uspto-mcp-server#readme',
    support: 'https://github.com/blen-labs/uspto-mcp-server/issues',
    license: pkg.license,
    keywords: ['uspto', 'patents', 'trademarks', 'ptab', 'office actions', 'code mode'],
    tools: [
      { name: 'search_api', description: 'Find USPTO SDK methods and response fields' },
      { name: 'describe_schema', description: 'Exact signature and fields for a method or namespace' },
      { name: 'execute', description: 'Run JavaScript against the odp and tsdr SDKs in a sandbox' },
    ],
    // isolated-vm ships prebuilt binaries for Node 24 and 26 (darwin-arm64, linux-x64/arm64,
    // win32-x64); elsewhere execute uses Deno if it is installed.
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=24.11.0' } },
    server: {
      type: 'node',
      entry_point: 'dist/bin.js',
      mcp_config: {
        command: 'node',
        // ${__dirname} is expanded by the MCPB host to the unpacked bundle dir.
        args: ['${__dirname}/dist/bin.js'],
        // USPTO keys are personal; the host prompts for them and keeps them in its secure store.
        env: {
          USPTO_API_KEY: '${user_config.uspto_api_key}',
          USPTO_TSDR_API_KEY: '${user_config.uspto_tsdr_api_key}',
        },
      },
    },
    user_config: {
      uspto_api_key: {
        type: 'string',
        title: 'USPTO Open Data Portal API key',
        description: 'Free: sign in at data.uspto.gov/myodp (USPTO.gov account verified with ID.me) and request a key. Used for patents, PTAB, petitions, office actions and bulk datasets.',
        sensitive: true,
        required: true,
      },
      uspto_tsdr_api_key: {
        type: 'string',
        title: 'USPTO TSDR API key (optional)',
        description: 'Separate key for trademark status, from account.uspto.gov/api-manager. Leave empty to disable tsdr.*.',
        sensitive: true,
        required: false,
      },
    },
  };
}

function main() {
  const root = resolve(process.cwd());
  const out = resolve(root, 'mcpb-build');
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });

  cpSync(resolve(root, 'dist'), resolve(out, 'dist'), { recursive: true });
  cpSync(resolve(root, 'schema'), resolve(out, 'schema'), { recursive: true });
  cpSync(resolve(root, 'package.json'), resolve(out, 'package.json'));
  // Reproducible: the bundle installs exactly the tested lockfile.
  cpSync(resolve(root, 'pnpm-lock.yaml'), resolve(out, 'pnpm-lock.yaml'));
  for (const f of ['LICENSE', 'NOTICE']) cpSync(resolve(root, f), resolve(out, f));
  if (existsSync(resolve(root, 'README.md'))) {
    cpSync(resolve(root, 'README.md'), resolve(out, 'README.md'));
  }

  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(buildManifest(pkg), null, 2));

  // The bundle must carry its production node_modules — Claude Desktop runs it
  // with a plain `node`, with no install step. Hoisted layout: pnpm's default
  // symlink store does not survive zipping. --ignore-scripts skips native builds:
  // isolated-vm loads its shipped prebuilt binary at runtime (Node 24/26 on the
  // common platforms); elsewhere execute falls back to Deno or reports
  // SandboxUnavailable with instructions.
  // --ignore-workspace is load-bearing: without it, pnpm walks up to the repo's
  // pnpm-workspace.yaml and installs (and --prod-prunes!) the ROOT node_modules
  // instead of the bundle's.
  execFileSync(
    'pnpm',
    ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace', '--config.node-linker=hoisted'],
    { cwd: out, stdio: 'inherit' },
  );

  // Fail loudly here rather than at `mcpb pack` time.
  execFileSync(
    process.execPath,
    [resolve(root, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js'), 'validate', resolve(out, 'manifest.json')],
    { stdio: 'inherit' },
  );

  console.log('mcpb-build/ prepared at', out);
  console.log('next: pnpm mcpb:pack   (packs mcpb-build/ into a .mcpb)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
