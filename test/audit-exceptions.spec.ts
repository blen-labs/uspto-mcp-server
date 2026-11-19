import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { splitAuditConfig, staleExceptions } from '../scripts/check-audit-exceptions.mjs';

// `auditConfig.ignoreGhsas` in pnpm-workspace.yaml skips an advisory on every dependency path:
// pnpm cannot limit it to dev tooling. Each entry needs a row here naming the package it covers,
// and the test holds the condition each entry states ("dev tooling only"). Delete a row together
// with its entry; the scheduled security workflow says when (scripts/check-audit-exceptions.mjs).
const EXCEPTIONS: Record<string, string> = {
  // 'GHSA-xxxx-xxxx-xxxx': 'package-name',
};

describe('audit exceptions', () => {
  const productionTree = (name: string) => {
    const r = spawnSync('pnpm', ['ls', '--prod', '--depth', 'Infinity', '--json', name], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    return (JSON.parse(r.stdout) as Array<{ dependencies?: Record<string, unknown> }>)[0]?.dependencies;
  };

  it('every ignored advisory has a row here', () => {
    const { ghsas } = splitAuditConfig(readFileSync('pnpm-workspace.yaml', 'utf8'));
    expect([...ghsas].sort()).toEqual(Object.keys(EXCEPTIONS).sort());
  });

  it('the production-tree query finds a package that ships', () => {
    // So an empty answer below means absent, not a broken query.
    expect(productionTree('zod')).toBeDefined();
  });

  it.each(Object.entries(EXCEPTIONS))('%s (%s) is not a production dependency', (_id, pkg) => {
    expect(productionTree(pkg)).toBeUndefined();
  });
});

describe('check-audit-exceptions', () => {
  const workspace = [
    'allowBuilds:',
    '  esbuild: true',
    '# Advisories with no patched release.',
    'auditConfig:',
    '  ignoreGhsas:',
    '    # why it cannot reach users',
    '    - GHSA-aaaa-bbbb-cccc',
    "    - 'GHSA-dddd-eeee-ffff' # quoted",
    '  ignoreCves: []',
    'overrides:',
    "  'a>b': ^1.0.0",
    '',
  ].join('\n');

  it('reads the ignored advisories and drops only the auditConfig block', () => {
    const { ghsas, rest } = splitAuditConfig(workspace);
    expect(ghsas).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff']);
    expect(rest).not.toMatch(/auditConfig|ignoreGhsas|GHSA-|ignoreCves/);
    expect(rest).toContain('allowBuilds:\n  esbuild: true');
    expect(rest).toContain("overrides:\n  'a>b': ^1.0.0");
  });

  it('finds nothing to drop in a workspace without auditConfig', () => {
    const plain = "overrides:\n  'a>b': ^1.0.0\n";
    expect(splitAuditConfig(plain)).toEqual({ ghsas: [], rest: plain });
  });

  it('keeps an exception whose advisory is still reported without a fix', () => {
    const audit = { advisories: { '1': { github_advisory_id: 'GHSA-aaaa-bbbb-cccc', module_name: 'x', patched_versions: '<0.0.0' } } };
    expect(staleExceptions(['GHSA-aaaa-bbbb-cccc'], audit)).toEqual([]);
  });

  it('flags an exception whose advisory is gone (withdrawn or outgrown)', () => {
    const [problem] = staleExceptions(['GHSA-aaaa-bbbb-cccc'], { advisories: {} });
    expect(problem).toMatch(/^GHSA-aaaa-bbbb-cccc: no longer reported/);
  });

  it('flags an exception whose advisory now has a fix', () => {
    const audit = { advisories: { '1': { github_advisory_id: 'GHSA-aaaa-bbbb-cccc', module_name: 'x', patched_versions: '>=4.0.8' } } };
    const [problem] = staleExceptions(['GHSA-aaaa-bbbb-cccc'], audit);
    expect(problem).toMatch(/x now has a fix \(>=4\.0\.8\)/);
  });
});
