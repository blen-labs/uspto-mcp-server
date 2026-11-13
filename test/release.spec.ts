import { describe, it, expect } from 'vitest';
import {
  computeBump,
  bumpVersion,
  renderChangelogSection,
  insertChangelogSection,
  updateVersionMarkers,
} from '../scripts/release-lib.mjs';

const c = (subject: string, body = '') => ({ subject, body });

describe('computeBump', () => {
  it('major on a bang subject', () => {
    expect(computeBump([c('feat(protocol)!: drop sessions')])).toBe('major');
  });
  it('major on a BREAKING CHANGE footer', () => {
    expect(computeBump([c('fix: x', 'BREAKING CHANGE: y')])).toBe('major');
  });
  it('minor when any feat is present', () => {
    expect(computeBump([c('fix: a'), c('feat: b')])).toBe('minor');
  });
  it('patch for fixes', () => {
    expect(computeBump([c('fix: a')])).toBe('patch');
  });
  it('patch for chore/ci/docs-only pushes — every merge releases', () => {
    expect(computeBump([c('ci: tweak workflow'), c('docs: readme')])).toBe('patch');
  });
});

describe('bumpVersion', () => {
  it('bumps each part and resets the lower ones', () => {
    expect(bumpVersion('2.0.1', 'major')).toBe('3.0.0');
    expect(bumpVersion('2.0.1', 'minor')).toBe('2.1.0');
    expect(bumpVersion('2.0.1', 'patch')).toBe('2.0.2');
  });
});

describe('renderChangelogSection', () => {
  it('groups commits under Keep-a-Changelog headings', () => {
    const s = renderChangelogSection('2.1.0', '2026-08-07', [
      c('feat(sdk): add ptab rss feed'),
      c('fix(http): correct 403 body'),
      c('ci: speed up install'),
    ]);
    expect(s).toContain('## [2.1.0] - 2026-08-07');
    expect(s).toMatch(/### Added[\s\S]*add ptab rss feed/);
    expect(s).toMatch(/### Fixed[\s\S]*correct 403 body/);
    expect(s).toMatch(/### Changed[\s\S]*speed up install/);
  });
  it('surfaces breaking changes in their own section', () => {
    const s = renderChangelogSection('3.0.0', '2026-08-07', [c('feat!: remove legacy leg')]);
    expect(s).toMatch(/### Breaking[\s\S]*remove legacy leg/);
  });
});

describe('insertChangelogSection', () => {
  const changelog = [
    '# Changelog', '',
    '## [Unreleased]', '',
    '## [2.0.0] - 2026-08-06', '', 'old content', '',
    '[Unreleased]: https://github.com/o/r/compare/v2.0.0...HEAD',
    '[2.0.0]: https://github.com/o/r/compare/v1.0.0...v2.0.0', '',
  ].join('\n');

  it('inserts the section after Unreleased and rewrites link refs', () => {
    const out = insertChangelogSection(changelog, '## [2.0.1] - 2026-08-07\n\n### Fixed\n- x\n', '2.0.1');
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [2.0.1]'));
    expect(out.indexOf('## [2.0.1]')).toBeLessThan(out.indexOf('## [2.0.0]'));
    expect(out).toContain('[Unreleased]: https://github.com/o/r/compare/v2.0.1...HEAD');
    expect(out).toContain('[2.0.1]: https://github.com/o/r/compare/v2.0.0...v2.0.1');
    expect(out).toContain('[2.0.0]: https://github.com/o/r/compare/v1.0.0...v2.0.0');
  });
});

describe('updateVersionMarkers', () => {
  it('rewrites the version only on marker lines', () => {
    const src = [
      "const other = '1.2.3';",
      "    { name: 'uspto-mcp-server', version: '2.0.0' }, // x-release-version",
    ].join('\n');
    const out = updateVersionMarkers(src, '2.0.1');
    expect(out).toContain("version: '2.0.1' }, // x-release-version");
    expect(out).toContain("const other = '1.2.3';");
  });
});

describe('release.mjs against disposable repositories', () => {
  const run = async (tagged: boolean) => {
    const { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const root = resolve(__dirname, '..');
    const dir = mkdtempSync(join(tmpdir(), 'uspto-release-'));
    for (const f of ['package.json', 'CHANGELOG.md']) cpSync(join(root, f), join(dir, f));
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['release.mjs', 'release-lib.mjs']) cpSync(join(root, 'scripts', f), join(dir, 'scripts', f));
    for (const f of ['src/server/mcpServer.ts', 'src/sdk/bindings.ts']) { mkdirSync(join(dir, f, '..'), { recursive: true }); cpSync(join(root, f), join(dir, f)); }
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'feat: initial');
    if (tagged) { git('tag', 'v0.1.0'); writeFileSync(join(dir, 'x.txt'), 'x'); git('add', '.'); git('commit', '-qm', 'feat(sdk): add something'); }
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    execFileSync(process.execPath, ['scripts/release.mjs'], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out, RELEASE_DATE: '2026-11-12' } });
    const outputs = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map(l => l.split('=') as [string, string]));
    return { outputs, notes: readFileSync(join(dir, 'release-notes.generated.md'), 'utf8'), pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
  };

  it('a fresh repository (no tags) releases the declared version with its hand-written notes', async () => {
    const { outputs, notes, pkg } = await run(false);
    expect(outputs).toMatchObject({ released: 'true', version: pkg.version, bump: 'initial' });
    expect(notes).toMatch(/Code-mode MCP server for the USPTO Open Data Portal/);
    expect(notes).not.toContain("[Unreleased]");
  });

  it('a tagged repository bumps from the last tag', async () => {
    const { outputs, pkg } = await run(true);
    expect(outputs).toMatchObject({ released: 'true', bump: 'minor', version: '0.2.0' });
    expect(pkg.version).toBe('0.2.0');
  });
});
