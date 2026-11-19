#!/usr/bin/env node
// Checks that every advisory muted by `auditConfig.ignoreGhsas` still deserves its exception.
//
//   node scripts/check-audit-exceptions.mjs [dir ...]     (default: . and site)
//
// For each pnpm root it copies package.json and pnpm-lock.yaml into a temporary directory with
// the workspace file minus `auditConfig`, runs `pnpm audit --json` there (it reads only the
// lockfile: nothing is installed, no package scripts run), and compares the unfiltered findings
// with the muted list. An exception fails the check when
//   - the advisory no longer matches the lockfile (withdrawn, or the package moved past it), or
//   - a patched release now exists (patched_versions is not "<0.0.0"),
// because either way the entry should be removed (and, for a fix, the package updated).
// Exit codes: 0 ok, 1 an exception is stale, 2 the audit itself could not run.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The `auditConfig.ignoreGhsas` list and the workspace text without the `auditConfig` block. */
export function splitAuditConfig(yamlText) {
  const lines = yamlText.split('\n');
  const kept = [];
  const ghsas = [];
  let inAudit = false;
  let inList = false;
  for (const line of lines) {
    if (/^\S/.test(line) && !line.startsWith('#')) {
      inAudit = /^auditConfig:\s*(#.*)?$/.test(line);
      inList = false;
    }
    if (!inAudit) {
      kept.push(line);
      continue;
    }
    if (/^\s+ignoreGhsas:\s*(#.*)?$/.test(line)) inList = true;
    else if (/^\s+[A-Za-z]\w*:/.test(line)) inList = false;
    const item = inList && /^\s+-\s*['"]?(GHSA(?:-[0-9a-z]{4}){3})['"]?\s*(#.*)?$/i.exec(line);
    if (item) ghsas.push(item[1]);
  }
  return { ghsas, rest: kept.join('\n') };
}

/** Problems with the muted advisories, given `pnpm audit --json` output run without them. */
export function staleExceptions(ghsas, audit) {
  const found = new Map();
  for (const a of Object.values(audit.advisories ?? {})) {
    if (a.github_advisory_id) found.set(a.github_advisory_id.toUpperCase(), a);
  }
  const problems = [];
  for (const id of ghsas) {
    const a = found.get(id.toUpperCase());
    if (!a) {
      problems.push(`${id}: no longer reported for this lockfile (withdrawn, or the package moved past it) - remove the entry`);
    } else if (a.patched_versions && a.patched_versions !== '<0.0.0') {
      problems.push(`${id}: ${a.module_name} now has a fix (${a.patched_versions}) - update it and remove the entry`);
    }
  }
  return problems;
}

function auditWithoutExceptions(dir) {
  const { ghsas, rest } = splitAuditConfig(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'));
  if (ghsas.length === 0) return { ghsas, problems: [] };
  const tmp = mkdtempSync(join(tmpdir(), 'audit-exceptions-'));
  try {
    copyFileSync(join(dir, 'package.json'), join(tmp, 'package.json'));
    copyFileSync(join(dir, 'pnpm-lock.yaml'), join(tmp, 'pnpm-lock.yaml'));
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), rest);
    // pnpm audit exits non-zero when it finds something; the JSON on stdout is what counts.
    const r = spawnSync('pnpm', ['audit', '--json'], { cwd: tmp, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let audit;
    try {
      audit = JSON.parse(r.stdout);
    } catch {
      throw new Error(`pnpm audit produced no JSON in ${dir}: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
    }
    if (audit.error) throw new Error(`pnpm audit failed in ${dir}: ${JSON.stringify(audit.error).slice(0, 500)}`);
    return { ghsas, problems: staleExceptions(ghsas, audit) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['.', 'site'];
  let failed = false;
  for (const d of dirs) {
    const dir = resolve(d);
    try {
      const { ghsas, problems } = auditWithoutExceptions(dir);
      if (ghsas.length === 0) console.log(`${d}: no audit exceptions`);
      else if (problems.length === 0) console.log(`${d}: ${ghsas.join(', ')} still unpatched; exception holds`);
      for (const p of problems) console.error(`${d}: ${p}`);
      if (problems.length) failed = true;
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(2);
    }
  }
  process.exit(failed ? 1 : 0);
}
