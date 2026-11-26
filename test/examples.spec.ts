import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fencedBlocks } from '../scripts/check-fences.mjs';
import { preflight } from '../src/sandbox/policy.js';
import { DenoRunner } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';

// examples/ is documented as paste-ready input for `execute`, so it must pass the
// same preflight the tool applies — plain JavaScript, no TypeScript syntax.
const dir = resolve(__dirname, '../examples');
const examples = readdirSync(dir).filter(f => f.endsWith('.js')).map(f => [f, readFileSync(resolve(dir, f), 'utf8')] as const);

// Each example has a fixture of synthetic upstream responses (test/fixtures/examples/<name>.json)
// and the value the program must return, for a match and for no match. The docs render the same
// fixtures as the example's output, so what they show is what these tests check.
interface Fixture { upstream: Record<string, unknown>; expected: unknown; noMatch: { upstream: Record<string, unknown>; expected: unknown } }
const fixture = (file: string) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures/examples', file.replace(/\.js$/, '.json')), 'utf8')) as Fixture;

// Answers each call from the fixture by its path and fails any call the fixture does not have, so
// an example that starts making another request must say so here.
const bridgeFor = (upstream: Record<string, unknown>) => ({
  dispatch: async ({ binding, path }: { binding: string; path: string[] }) => {
    const name = `${binding}.${path.join('.')}`;
    return name in upstream
      ? { ok: true, value: upstream[name] }
      : { ok: false, error: { name: 'NotFound', message: `no fixture for ${name}` } };
  },
});

describe('examples/', () => {
  it('contains only paste-ready .js snippets', () => {
    expect(examples.length).toBeGreaterThan(0);
    expect(readdirSync(dir).filter(f => f.endsWith('.ts'))).toEqual([]);
  });

  it.each(examples)('%s passes execute preflight', (_name, code) => {
    expect(preflight(code)).toMatchObject({ ok: true });
  });

  it('preflight rejects TypeScript type annotations (why the examples are plain JS)', () => {
    expect(preflight('const x: number = 1; return x;').ok).toBe(false);
  });

  describe.each([new IsolateRunner(), new DenoRunner()])('$kind', runner => {
    // `it.for` (not `it.each`) passes the test context, which carries `skip`.
    it.for(examples)('%s returns the documented result', async ([name, code], { skip }) => {
      if (!(await runner.available())) return skip();
      const { upstream, expected } = fixture(name);
      const res = await runner.execute({ code, bindings: ['odp', 'tsdr'], timeoutMs: 3000 }, bridgeFor(upstream));
      expect(res).toMatchObject({ ok: true });
      expect(res.value).toEqual(expected);
    });

    it.for(examples)('%s returns the documented result, without throwing, when nothing matches', async ([name, code], { skip }) => {
      if (!(await runner.available())) return skip();
      const { noMatch } = fixture(name);
      const res = await runner.execute({ code, bindings: ['odp', 'tsdr'], timeoutMs: 3000 }, bridgeFor(noMatch.upstream));
      expect(res).toMatchObject({ ok: true });
      expect(res.value).toEqual(noMatch.expected);
    });
  });
});

// The README's featured program is the tested file, not a copy, and shows its recorded output.
describe('README example', () => {
  const readme = fencedBlocks(readFileSync(resolve(__dirname, '../README.md'), 'utf8'));
  const featured = 'ptab-challenges.js';
  const { expected, noMatch } = fixture(featured);
  const json = (value: unknown) => JSON.stringify(value, null, 2);

  it('shows the tested program verbatim', () => {
    expect(readme.filter(b => b.info === 'js').map(b => b.body)).toContain(readFileSync(resolve(dir, featured), 'utf8').trimEnd());
  });

  it('shows the program output and the no-match output', () => {
    const shown = readme.filter(b => b.info === 'json').map(b => b.body);
    expect(shown).toContain(json(expected));
    expect(shown).toContain(json(noMatch.expected));
  });
});
