#!/usr/bin/env node
// Captures live sample responses for the field dictionary (scripts/field-samples.json entries with
// source "live"), one request at a time, through the built SDK.
//
//   pnpm build && USPTO_API_KEY=... node scripts/capture-samples.mjs <out-dir>
//
// Read-only and small (a handful of records per dataset). Responses stay in <out-dir>; only field
// names and non-personal example values reach schema/*.json (see scripts/gen-fields.mjs). Never
// commit captures: they are public records that contain names and addresses.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) { console.error('usage: node scripts/capture-samples.mjs <out-dir>'); process.exit(2); }
const key = process.env.USPTO_API_KEY?.trim();
if (!key) { console.error('USPTO_API_KEY is required'); process.exit(2); }

const { getSources } = await import(resolve(root, 'dist/sdk/sources/index.js'));
const { keyGate, LIMIT_DEFAULTS } = await import(resolve(root, 'dist/supervisor/index.js'));
const odp = getSources({
  odp: { baseUrl: 'https://api.uspto.gov', apiKey: key, gate: keyGate(LIMIT_DEFAULTS.odp) },
  tsdr: { baseUrl: 'https://tsdrapi.uspto.gov' },
  userAgent: 'uspto-mcp-server/0.1 (field dictionary capture)', timeoutMs: 30_000, retries: 1,
  cacheTtlMs: 0, cacheMaxItems: 0,
}).find(s => s.name === 'odp');

const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/field-samples.json'), 'utf8'));
mkdirSync(out, { recursive: true });
const provenance = { capturedAt: new Date().toISOString(), host: 'https://api.uspto.gov', files: {} };
for (const e of manifest.entries.filter(x => x.source === 'live')) {
  const method = odp.methods[e.capture.method];
  if (!method) throw new Error(`unknown method ${e.capture.method}`);
  const value = await method(...e.capture.args);
  const text = JSON.stringify(value, null, 2).split(key).join('[REDACTED]');
  writeFileSync(resolve(out, e.file), text);
  provenance.files[e.file] = { method: `odp.${e.capture.method}`, args: e.capture.args, sha256: createHash('sha256').update(text).digest('hex') };
  console.log(`captured ${e.file}`);
}
writeFileSync(resolve(out, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2));
