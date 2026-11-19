#!/usr/bin/env node
// Dependency audit for the scheduled security workflow (.github/workflows/security.yml).
//
//   node scripts/security-audit.mjs [dir ...]     (default: . and site)
//
// For each pnpm root it
//   1. runs `pnpm audit --json` as CI does (exceptions applied) and reports every advisory at
//      moderate or above, i.e. what `pnpm audit --audit-level moderate` fails on;
//   2. checks that every advisory muted by `auditConfig.ignoreGhsas` still deserves it. The muted
//      list comes from `pnpm config get auditConfig`, so it is exactly what pnpm applies, however
//      the YAML spells it. The script copies package.json, pnpm-lock.yaml, .pnpmfile.cjs and
//      .npmrc (when present) into a temporary directory with the workspace file minus
//      `auditConfig`, confirms pnpm sees no exceptions there, and audits again. An exception is
//      stale when its advisory is no longer reported (withdrawn, or the package moved past it)
//      or now has a patched release.
// `pnpm audit` reads only the lockfile: nothing is installed and no package scripts run.
//
// Exit codes: 0 clean; 1 findings or stale exceptions (a person has to act); 2 the audit itself
// could not run (registry or network trouble; the workflow retries and opens no issue).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FAILING_SEVERITIES = new Set(['moderate', 'high', 'critical']);
const COPIED_FILES = ['package.json', 'pnpm-lock.yaml', '.pnpmfile.cjs', '.npmrc'];

class AuditUnavailable extends Error {}

/** The workspace text without the top-level `auditConfig` key, in any YAML style. */
export function stripAuditConfig(yamlText) {
  const kept = [];
  let inAudit = false;
  for (const line of yamlText.split('\n')) {
    // A top-level key starts a new block; comments and indented or blank lines continue one.
    if (/^[^\s#]/.test(line)) inAudit = /^['"]?auditConfig['"]?\s*:/.test(line);
    if (!inAudit) kept.push(line);
  }
  return kept.join('\n');
}

/** Advisories `pnpm audit --audit-level moderate` fails on, from `pnpm audit --json`. */
export function failingAdvisories(audit) {
  return Object.values(audit.advisories ?? {})
    .filter(a => FAILING_SEVERITIES.has(a.severity))
    .map(a => `${a.github_advisory_id ?? a.id} (${a.severity}) in ${a.module_name}: ${a.title}`);
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
      problems.push(`${id}: no longer reported for this lockfile (withdrawn, or the package moved past it) - remove the exception`);
    } else if (a.patched_versions && a.patched_versions !== '<0.0.0') {
      problems.push(`${id}: ${a.module_name} now has a fix (${a.patched_versions}) - update it and remove the exception`);
    }
  }
  return problems;
}

/** The advisories pnpm mutes in `dir`, as pnpm itself reads them. */
export function ignoredGhsas(dir) {
  const r = spawnSync('pnpm', ['config', 'get', 'auditConfig', '--json'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new AuditUnavailable(`pnpm config failed in ${dir}: ${r.stderr.trim().slice(0, 500)}`);
  const text = r.stdout.trim();
  if (!text || text === 'undefined') return [];
  const ghsas = JSON.parse(text).ignoreGhsas ?? [];
  if (!Array.isArray(ghsas)) throw new Error(`${dir}: auditConfig.ignoreGhsas is not a list`);
  return ghsas.map(String);
}

function audit(dir) {
  const r = spawnSync('pnpm', ['audit', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // pnpm audit exits non-zero when it finds something; only JSON with metadata is a real answer.
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new AuditUnavailable(`pnpm audit gave no report in ${dir}: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  }
  if (report.error || !report.metadata) {
    throw new AuditUnavailable(`pnpm audit failed in ${dir}: ${JSON.stringify(report.error ?? report).slice(0, 500)}`);
  }
  return report;
}

function checkRoot(dir) {
  const problems = failingAdvisories(audit(dir));
  const ghsas = ignoredGhsas(dir);
  if (ghsas.length === 0) return { ghsas, problems };
  const tmp = mkdtempSync(join(tmpdir(), 'security-audit-'));
  try {
    for (const f of COPIED_FILES) {
      if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(tmp, f));
    }
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), stripAuditConfig(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')));
    const left = ignoredGhsas(tmp);
    if (left.length) throw new Error(`${dir}: could not remove exceptions for the check (pnpm still mutes ${left.join(', ')})`);
    problems.push(...staleExceptions(ghsas, audit(tmp)));
    return { ghsas, problems };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['.', 'site'];
  let code = 0;
  for (const d of dirs) {
    try {
      const { ghsas, problems } = checkRoot(resolve(d));
      for (const p of problems) console.error(`${d}: ${p}`);
      if (problems.length) code = Math.max(code, 1);
      else console.log(`${d}: no advisories${ghsas.length ? `; exceptions ${ghsas.join(', ')} still unpatched` : ''}`);
    } catch (err) {
      console.error(`${d}: ${err instanceof Error ? err.message : err}`);
      code = err instanceof AuditUnavailable ? Math.max(code, 2) : 1;
    }
  }
  process.exit(code);
}
