#!/usr/bin/env node
// Regenerates the method reference in docs/sdk-reference.md from schema/{odp,tsdr}.json, between
// the BEGIN/END GENERATED markers. Hand-written sections outside the markers are kept.
//
//   node scripts/gen-sdk-reference.mjs           # rewrite the section
//   node scripts/gen-sdk-reference.mjs --check   # exit 1 if the doc is out of date (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(root, 'docs/sdk-reference.md');
const BEGIN = '<!-- BEGIN GENERATED: method reference (scripts/gen-sdk-reference.mjs) -->';
const END = '<!-- END GENERATED: method reference -->';

const groupOf = id => {
  const parts = id.split('.');
  return parts.length > 3 ? parts.slice(0, 3).join('.') : parts.slice(0, 2).join('.');
};

const out = [BEGIN, '', '_Generated from `schema/odp.json` and `schema/tsdr.json`; edit those, then run `node scripts/gen-sdk-reference.mjs`._', ''];
for (const binding of ['odp', 'tsdr']) {
  const corpus = JSON.parse(readFileSync(resolve(root, `schema/${binding}.json`), 'utf8'));
  let group = '';
  for (const e of corpus.endpoints) {
    const g = binding === 'tsdr' ? 'tsdr' : groupOf(e.id);
    if (g !== group) { group = g; out.push(`### \`${g}\``, ''); }
    out.push(`#### \`${e.signature}\``, '', e.description, '');
    if (e.example) out.push('```js', e.example, '```', '');
  }
}
out.push(END);
const generated = out.join('\n');

const doc = readFileSync(docPath, 'utf8');
const start = doc.indexOf(BEGIN);
const end = doc.indexOf(END);
const next = start >= 0 && end > start
  ? doc.slice(0, start) + generated + doc.slice(end + END.length)
  : `${doc.trimEnd()}\n\n## Method reference\n\n${generated}\n`;

if (process.argv.includes('--check')) {
  if (next !== doc) { console.error('docs/sdk-reference.md is out of date: run node scripts/gen-sdk-reference.mjs'); process.exit(1); }
  console.log('docs/sdk-reference.md is up to date');
} else {
  writeFileSync(docPath, next);
  console.log('docs/sdk-reference.md regenerated');
}
