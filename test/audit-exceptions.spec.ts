import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

// `auditConfig.ignoreGhsas` in pnpm-workspace.yaml skips an advisory on every dependency path:
// pnpm cannot limit it to dev tooling. This holds the condition each entry states ("dev tooling
// only"). Delete a case together with its entry.
describe('audit exceptions', () => {
  const productionTree = (name: string) => {
    const r = spawnSync('pnpm', ['ls', '--prod', '--depth', 'Infinity', '--json', name], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    return (JSON.parse(r.stdout) as Array<{ dependencies?: Record<string, unknown> }>)[0]?.dependencies;
  };

  it('picomatch (GHSA-fc5q-39xc-vjpf) is not a production dependency', () => {
    expect(productionTree('picomatch')).toBeUndefined();
    // The same query does find a package that ships, so an empty answer means absent.
    expect(productionTree('zod')).toBeDefined();
  });
});
