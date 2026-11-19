#!/usr/bin/env node
// Continuous release: called by .github/workflows/release.yml on every push
// to main. Decides whether the commits since the last tag can change what users
// install (releaseReason in scripts/release-lib.mjs: commit types, the paths
// they touch, and package.json's shipped fields); if not, it reports
// released=false and nothing is published. Otherwise it computes the next
// version from their conventional-commit types, stamps package.json + the
// x-release-version source markers, prepends a CHANGELOG section, and writes
// step outputs for the workflow to commit/tag/publish. RELEASE_FORCE=1 (the
// workflow's `force` dispatch input) releases a range that would be skipped.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { changedManifestFields, releaseReason, computeBump, bumpVersion, renderChangelogSection, insertChangelogSection, updateVersionMarkers } from './release-lib.mjs';

const MARKER_FILES = ['src/server/mcpServer.ts', 'src/sdk/bindings.ts'];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`release: ${key}=${value}`);
}

/** Latest tag, or undefined in a repository that has never been released. */
function latestTag() {
  try { return git('describe', '--tags', '--abbrev=0'); } catch { return undefined; }
}

const lastTag = latestTag();
if (!lastTag) {
  // Initial release: publish the version package.json already declares, with the CHANGELOG
  // section written for it by hand. No bump: there is nothing to bump from.
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const start = changelog.indexOf(`## [${version}]`);
  if (start < 0) throw new Error(`Initial release: CHANGELOG.md has no "## [${version}]" section`);
  const rest = changelog.slice(start).split('\n').slice(1);
  const end = rest.findIndex(l => l.startsWith('## [') || /^\[[^\]]+\]: /.test(l));
  const notesFile = 'release-notes.generated.md';
  writeFileSync(notesFile, `${rest.slice(0, end < 0 ? undefined : end).join('\n').trim()}\n`);
  setOutput('released', 'true');
  setOutput('version', version);
  setOutput('bump', 'initial');
  setOutput('notes_file', notesFile);
  process.exit(0);
}
// ASCII record/field separators, emitted by git via %x1e/%x1f so no raw
// control characters live in this file. Each record is subject, body, then the
// commit's changed paths (--name-only prints them after the format line).
const RECORD = '\x1e';
const FIELD = '\x1f';
const raw = git('log', `${lastTag}..HEAD`, '--no-merges', '--name-only', '--format=%x1e%s%x1f%b%x1f');
const commits = raw
  .split(RECORD)
  .map(r => r.trim())
  .filter(Boolean)
  .map(r => {
    const [subject, body = '', files = ''] = r.split(FIELD);
    return { subject: subject.trim(), body, files: files.split('\n').map(f => f.trim()).filter(Boolean) };
  })
  // Never let a prior release commit feed the next bump, nor a merge message that arrived as a
  // single-parent commit (e.g. a squash titled "Merge pull request #N"); --no-merges skips real ones.
  .filter(c => !c.subject.startsWith('chore(release):') && !/^Merge (pull request|branch) /.test(c.subject));

if (commits.length === 0) {
  console.log(`release: no commits since ${lastTag} - nothing to release`);
  setOutput('released', 'false');
  process.exit(0);
}

let manifestFields;
try {
  manifestFields = changedManifestFields(
    JSON.parse(git('show', `${lastTag}:package.json`)),
    JSON.parse(readFileSync('package.json', 'utf8')),
  );
} catch (err) {
  // Fail safe: if the comparison cannot be made, assume the manifest changed.
  manifestFields = [`(could not compare with ${lastTag}: ${err instanceof Error ? err.message.split('\n')[0] : err})`];
}
const reason = releaseReason(commits, { manifestFields });
const force = process.env.RELEASE_FORCE === '1' || process.env.RELEASE_FORCE === 'true';
if (!reason && !force) {
  console.log(
    `release: none of the ${commits.length} commit(s) since ${lastTag} can change the published package ` +
      '(build/chore/ci/docs/style/test only, no shipped path or package.json field) - nothing to release; ' +
      'they ship with the next release, or run the release workflow with `force` to release them now',
  );
  setOutput('released', 'false');
  process.exit(0);
}
console.log(`release: releasing because ${reason ?? 'RELEASE_FORCE is set'}`);

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const bump = computeBump(commits);
const version = bumpVersion(current, bump);
const date = process.env.RELEASE_DATE ?? new Date().toISOString().slice(0, 10);

const pkg = readFileSync('package.json', 'utf8');
writeFileSync('package.json', pkg.replace(`"version": "${current}"`, `"version": "${version}"`));
for (const file of MARKER_FILES) {
  writeFileSync(file, updateVersionMarkers(readFileSync(file, 'utf8'), version));
}

const section = renderChangelogSection(version, date, commits);
writeFileSync('CHANGELOG.md', insertChangelogSection(readFileSync('CHANGELOG.md', 'utf8'), section, version));

const notesFile = 'release-notes.generated.md';
writeFileSync(notesFile, `${section.split('\n').slice(2).join('\n').trim()}\n`);

setOutput('released', 'true');
setOutput('version', version);
setOutput('bump', bump);
setOutput('notes_file', notesFile);
