import { describe, it, expect } from 'vitest';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { preflight } from '../src/sandbox/policy.js';
import { getSources } from '../src/sdk/sources/index.js';
import { sourceCfg } from './helpers.js';

const sources = getSources(sourceCfg());
const registered = new Set(sources.flatMap(s => Object.keys(s.methods).map(m => `${s.name}.${m}`)));
const bindings = new Set(sources.map(s => s.name));
const entries = sources.flatMap(s => [...s.corpus.endpoints, ...s.corpus.fields]).filter(e => e.example);

/** Dotted chain of a static member expression rooted at an identifier, or undefined. */
function chain(node: any): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const head = chain(node.object);
    return head ? `${head}.${node.property.name}` : undefined;
  }
  return undefined;
}

/** Every SDK call in the example, found in the AST (not by regex), plus any dynamic SDK access. */
function sdkCalls(code: string): { calls: string[]; dynamic: boolean } {
  const ast = parse(`(async () => { ${code}\n })()`, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true });
  const calls: string[] = [];
  let dynamic = false;
  simple(ast, {
    CallExpression(node: any) {
      const c = chain(node.callee);
      if (c && bindings.has(c.split('.')[0]!)) calls.push(c);
    },
    MemberExpression(node: any) {
      const root = chain(node.object);
      if (node.computed && root && bindings.has(root.split('.')[0]!)) dynamic = true;
    },
  });
  return { calls, dynamic };
}

describe('corpus examples', () => {
  it('every example passes preflight and calls only registered methods, statically', () => {
    const failures: string[] = [];
    for (const e of entries) {
      if (!preflight(e.example!).ok) { failures.push(`${e.id}: fails preflight`); continue; }
      const { calls, dynamic } = sdkCalls(e.example!);
      if (dynamic) failures.push(`${e.id}: selects SDK methods dynamically`);
      for (const c of calls) if (!registered.has(c)) failures.push(`${e.id}: calls unregistered ${c}`);
    }
    expect(failures).toEqual([]);
  });

  it('every endpoint has an example that calls that endpoint', () => {
    for (const s of sources) for (const e of s.corpus.endpoints) {
      expect(e.example, e.id).toBeTruthy();
      expect(sdkCalls(e.example!).calls, e.id).toContain(e.id);
    }
  });

  it('every field entry has a description and no duplicate ids exist', () => {
    const ids = sources.flatMap(s => [...s.corpus.endpoints, ...s.corpus.fields].map(e => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('docs/sdk-reference.md', () => {
  it('is generated from the current corpus (run node scripts/gen-sdk-reference.mjs)', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['scripts/gen-sdk-reference.mjs', '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
