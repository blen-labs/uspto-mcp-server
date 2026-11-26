import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fencedBlocks, trackedMarkdown, unlabelledFences } from '../scripts/check-fences.mjs';

const root = resolve(__dirname, '..');

describe('code fence labels', () => {
  it('flags only fences that open without a language', () => {
    const md = [
      '```', 'bare', '```',
      '```text', 'ok', '```',
      '  ````md', '```', 'nested bare fence inside a longer fence', '```', '  ````',
      '~~~', 'tilde', '~~~',
      '```js title="a.js"', 'x', '```',
      '', '```', 'unclosed',
    ].join('\n');
    expect(unlabelledFences(md)).toEqual([1, 12, 19]);
  });

  it('reads the language and body of each block', () => {
    expect(fencedBlocks('```bash\nls\npwd\n```\n')).toEqual([{ line: 1, info: 'bash', body: 'ls\npwd' }]);
  });

  it('every tracked Markdown and MDX file labels its code fences', () => {
    const files = trackedMarkdown();
    expect(files).toEqual(expect.arrayContaining(['README.md', 'docs/architecture.md', 'site/src/content/docs/recipes.mdx']));
    const bad = files.flatMap(f => unlabelledFences(readFileSync(resolve(root, f), 'utf8')).map(line => `${f}:${line}`));
    expect(bad).toEqual([]);
  });
});
