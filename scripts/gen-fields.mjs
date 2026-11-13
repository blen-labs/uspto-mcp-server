#!/usr/bin/env node
// Regenerates the response-field dictionary in schema/{odp,tsdr}.json from sample responses.
//
//   node scripts/gen-fields.mjs --source live=<dir> --source patent-dev=<dir>
//
// Every entry in scripts/field-samples.json names a source; each source maps to a directory of
// captured responses (live captures come from scripts/capture-samples.mjs). The whole manifest is
// validated first: a missing file or a response without the expected array fails the run and
// nothing is written. Output is staged and then renamed into place. Only entries whose id starts
// with `<binding>.fields.` are replaced; hand-written endpoints and curated fields are kept.
//
// Personal data: captures are public records containing names, addresses and e-mails. Example
// values are never emitted for fields that hold personal data or free text; field names are.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '--source') continue;
  const [name, dir] = String(process.argv[++i] ?? '').split('=');
  if (!name || !dir) { console.error('--source expects name=dir'); process.exit(2); }
  dirs[name] = resolve(dir);
}
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/field-samples.json'), 'utf8'));
const MAX_PER_GROUP = 150;

const USAGE = {
  odp: ' Use these dotted paths (relative to the record) in q, filters, rangeFilters, sort, fields and facets; not every response field is searchable, so facet or test a filter before relying on it.',
  'odp-get': ' Use these paths in q; this GET-only endpoint takes at most one filter and one rangeFilter.',
  dsapi: ' Legacy DSAPI: use these names in the Lucene criteria string (name:value, AND/OR, [a TO b]); page with { start, rows }. The odp search body (q/filters/fields) does not apply here.',
};

/** Fields whose values are personal data or free text: names only, never example values. */
const PERSONAL = /(name|address|street|line\d|city|postal|zip|e-?mail|phone|fax|correspondence|attorney|agent|examiner|inventor|applicant|owner|counsel|party|signature|customer)/i;
const FREE_TEXT = /(ocr|text$|body|description$|remarks|summary|translation|allSearchableFields|gsList\.description)/i;

function at(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Leaf paths (dotted, arrays flattened, numeric map keys collapsed to '*') with one example. */
function leaves(value, prefix, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) { if (prefix && !out.has(prefix)) out.set(prefix, undefined); return; }
    for (const v of value.slice(0, 5)) leaves(v, prefix, out);
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      const k = /^\d+$/.test(key) ? '*' : key;
      leaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (prefix && (out.get(prefix) === undefined || out.get(prefix) === null)) {
    out.set(prefix, value);
  }
}

function example(path, v) {
  if (v === null || v === undefined || v === '') return '';
  const last = path.split('.').slice(-2).join('.');
  if (PERSONAL.test(last) || (typeof v === 'string' && FREE_TEXT.test(last))) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return ` (e.g. ${JSON.stringify(s.length > 40 ? s.slice(0, 37) + '...' : s)})`;
}

// 1. Validate everything before writing anything.
const problems = [];
const loaded = [];
for (const m of manifest.entries) {
  const dir = dirs[m.source];
  if (!dir) { problems.push(`${m.file}: no --source ${m.source}=<dir> given`); continue; }
  const file = resolve(dir, m.file);
  if (!existsSync(file)) { problems.push(`${m.file}: missing in ${dir}`); continue; }
  const text = readFileSync(file, 'utf8');
  let json;
  try { json = JSON.parse(text); } catch { problems.push(`${m.file}: not JSON`); continue; }
  const records = at(json, m.bag);
  if (!Array.isArray(records) || records.length === 0) { problems.push(`${m.file}: no records at ${m.bag}`); continue; }
  loaded.push({ m, records, sha256: createHash('sha256').update(text).digest('hex') });
}
if (problems.length) {
  console.error('Nothing written. Fix these first:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// 2. Build.
const generated = { odp: [], tsdr: [] };
const provenance = { odp: {}, tsdr: {} };
for (const { m, records, sha256 } of loaded) {
  const paths = new Map();
  for (const r of records.slice(0, 10)) leaves(r, '', paths);
  const groups = new Map();
  for (const [path, v] of paths) {
    const [head, ...rest] = path.split('.');
    const group = rest.length ? head : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([path, v]);
  }
  for (const [group, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    items.sort(([a], [b]) => a.localeCompare(b));
    const shown = items.slice(0, MAX_PER_GROUP).map(([p, v]) => `${p}${example(p, v)}`).join('; ');
    const more = items.length > MAX_PER_GROUP ? `; ... ${items.length - MAX_PER_GROUP} more` : '';
    const where = group ? `${m.bag}[].${group}` : `${m.bag}[]`;
    generated[m.binding].push({
      id: `${m.binding}.fields.${m.dataset}${group ? '.' + group : ''}`,
      kind: 'field',
      binding: m.binding,
      description: `Response fields of ${m.methods}, under ${where}.${USAGE[m.query] ?? ''} Fields: ${shown}${more}.`,
    });
  }
  provenance[m.binding][m.file] = { source: m.source, sha256 };
}

// 3. Stage, then rename into place.
for (const binding of Object.keys(generated)) {
  const path = resolve(root, `schema/${binding}.json`);
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  const kept = corpus.fields.filter(f => !f.id.startsWith(`${binding}.fields.`));
  const ids = new Set();
  for (const f of [...kept, ...generated[binding]]) {
    if (ids.has(f.id)) { console.error(`Nothing written: duplicate id ${f.id}`); process.exit(1); }
    ids.add(f.id);
  }
  const used = new Set(Object.values(provenance[binding]).map(p => p.source));
  const next = {
    provenance: {
      generatedBy: 'scripts/gen-fields.mjs',
      generatedAt: new Date().toISOString().slice(0, 10),
      sources: Object.fromEntries([...used].map(s => [s, manifest.sources[s]])),
      files: provenance[binding],
    },
    endpoints: corpus.endpoints,
    fields: [...kept, ...generated[binding]],
  };
  writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
  console.log(`${binding}: ${kept.length} curated + ${generated[binding].length} generated field entries`);
}
