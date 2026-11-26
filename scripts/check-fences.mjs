#!/usr/bin/env node
// Rejects Markdown/MDX code fences that open without a language: label shell as `bash`, JSON as
// `json`, and diagrams or directory trees as `text`. A label lets the site highlight the block and
// tells a screen reader and a copy button what it holds.
//
//   node scripts/check-fences.mjs [file ...]     (default: every tracked .md and .mdx file)
//
// Exit codes: 0 clean; 1 unlabelled fences found.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FENCE = /^ *(`{3,}|~{3,})(.*)$/;

/** Every fenced code block: the line it opens on (1-based), its info string, and its text. */
export function fencedBlocks(markdown) {
  const blocks = [];
  let open = null;
  markdown.split('\n').forEach((line, index) => {
    const match = FENCE.exec(line);
    if (open) {
      // A closing fence uses the same character, is at least as long, and carries no text.
      if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length && match[2].trim() === '') {
        blocks.push({ line: open.line, info: open.info, body: open.body.join('\n') });
        open = null;
      } else open.body.push(line);
      return;
    }
    // An info string after a backtick fence cannot itself contain a backtick.
    if (!match || (match[1][0] === '`' && match[2].includes('`'))) return;
    open = { marker: match[1], info: match[2].trim(), line: index + 1, body: [] };
  });
  // An unclosed fence runs to the end of the file.
  if (open) blocks.push({ line: open.line, info: open.info, body: open.body.join('\n') });
  return blocks;
}

/** Line numbers (1-based) of fences that open without an info string. */
export const unlabelledFences = (markdown) => fencedBlocks(markdown).filter((b) => b.info === '').map((b) => b.line);

export function trackedMarkdown() {
  const out = execFileSync('git', ['ls-files', '-z', '*.md', '*.mdx'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : trackedMarkdown();
  let failed = false;
  for (const file of files) {
    for (const line of unlabelledFences(readFileSync(file, 'utf8'))) {
      console.error(`${file}:${line}: code fence has no language (use bash, json, js, text, ...)`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
