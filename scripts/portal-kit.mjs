#!/usr/bin/env node
// The portal kit: files every BLEN MCP server's portal shares byte for byte (tokens, UI
// primitives, page layout, landing page). Product content lives in web/src/brand.tsx and the
// per-product pages, never in these files. web/portal-kit.json records the source repository,
// the commit of that repository the manifest was last written on (`commit`: the HEAD that
// --update ran on, so uncommitted kit edits sit on top of it), and each file's SHA-256. Servers
// that copy the kit copy the manifest too, so their `commit` says which uspto-mcp-server
// commit their kit came from.
//
//   node scripts/portal-kit.mjs            check the files against the manifest (exit 1 on drift)
//   node scripts/portal-kit.mjs --update   rewrite the hashes and commit (in the repository that owns the kit)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MANIFEST = 'web/portal-kit.json';
const DIRS = ['web/src/components/kit', 'web/src/components/ui'];
const FILES = ['web/src/index.css', 'web/src/lib/utils.ts', 'web/src/assets/blen-logo.png'];

/** Every kit file, as repository-relative POSIX paths, sorted. */
export function kitFiles(root = '.') {
  const fromDirs = DIRS.flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `${dir}/${e.name}`),
  );
  return [...fromDirs, ...FILES].sort();
}

export function hashes(root = '.') {
  return Object.fromEntries(
    kitFiles(root).map((file) => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]),
  );
}

/** The HEAD commit of the repository at `root`, the same directory the manifest and kit files are read from. */
export function headCommit(root = '.') {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

/** Differences between the files on disk and the manifest, as readable lines. */
export function drift(root = '.') {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  const actual = hashes(root);
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? '')) problems.push('commit: missing or not a full commit SHA');
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!(file in actual)) problems.push(`${file}: missing`);
    else if (actual[file] !== hash) problems.push(`${file}: changed`);
  }
  for (const file of Object.keys(actual)) if (!(file in manifest.files)) problems.push(`${file}: not in the manifest`);
  return problems;
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  if (process.argv.includes('--update')) {
    const { files: _files, commit: _commit, ...rest } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const manifest = { ...rest, commit: headCommit(), files: hashes() };
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${MANIFEST}: ${Object.keys(manifest.files).length} files at ${manifest.commit.slice(0, 7)}`);
  } else {
    const problems = drift();
    if (problems.length) {
      console.error(`The portal kit differs from ${MANIFEST}:\n  ${problems.join('\n  ')}`);
      console.error('Change kit files in uspto-mcp-server, then copy them here with the new manifest (its `commit` records which uspto-mcp-server commit the copy came from).');
      process.exit(1);
    }
    console.log('portal kit: matches the manifest');
  }
}
