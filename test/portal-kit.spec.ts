import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { drift, kitFiles } from '../scripts/portal-kit.mjs';

const copies: string[] = [];
afterEach(() => { for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A copy of the kit and its manifest, as another server holds them; `edit` changes the manifest. */
function copyKit(edit: (manifest: Record<string, unknown>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-kit-'));
  copies.push(dir);
  for (const file of kitFiles()) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    cpSync(file, join(dir, file));
  }
  const manifest = JSON.parse(readFileSync('web/portal-kit.json', 'utf8')) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(join(dir, 'web/portal-kit.json'), JSON.stringify(manifest));
  return dir;
}

describe('portal kit', () => {
  it('matches web/portal-kit.json (shared byte for byte with the other BLEN MCP servers)', () => {
    expect(drift()).toEqual([]);
  });

  it('records the uspto-mcp-server commit the kit was written on', () => {
    expect(JSON.parse(readFileSync('web/portal-kit.json', 'utf8')).commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('accepts a copy of the kit with its manifest, wherever it lives', () => {
    expect(drift(copyKit())).toEqual([]);
  });

  it('reports a manifest without a valid commit', () => {
    expect(drift(copyKit(m => { delete m.commit; }))).toEqual(['commit: missing or not a full commit SHA']);
    expect(drift(copyKit(m => { m.commit = 'main'; }))).toEqual(['commit: missing or not a full commit SHA']);
  });
});
