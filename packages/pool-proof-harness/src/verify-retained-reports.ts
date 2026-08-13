import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateReport } from './report.ts';
import { validateStage2Report } from './stage-2-report.ts';
// @ts-expect-error worker-harness JSON schema validator has no type declarations
import { validateInstance } from '../../worker-harness/lib/json-schema-subset.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportsDir = join(packageRoot, 'reports');
const lifecycleSchema = JSON.parse(readFileSync(join(packageRoot, 'contracts', 'persistent-attempt-sandbox-lifecycle-report.schema.json'), 'utf8')) as Record<string, unknown>;

export const RETAINED_REPORTS = Object.freeze({
  'stage-1': 'stage-1-proof-report.json',
  'stage-2': 'stage-2-proof-report.json',
  'sandbox-lifecycle': 'persistent-attempt-sandbox-lifecycle-report.json',
});
export type RetainedReportSelector = keyof typeof RETAINED_REPORTS;
type Manifest = { readonly schema_version: 1; readonly reports: Record<string, string> };

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateLifecycleReport(report: unknown): { ok: true } | { ok: false; error: string } {
  const errors = validateInstance(lifecycleSchema, report);
  return errors.length === 0 ? { ok: true } : { ok: false, error: `schema validation failed: ${errors.join('; ')}` };
}

export function validateRetainedCandidate(selector: RetainedReportSelector, report: unknown, reportsDir = defaultReportsDir): { ok: true } | { ok: false; error: string } {
  if (selector === 'stage-1') return validateReport(report);
  if (selector === 'sandbox-lifecycle') return validateLifecycleReport(report);
  const stage2 = validateStage2Report(report);
  if (!stage2.ok) return stage2;
  const expectedStage1 = sha256File(join(reportsDir, RETAINED_REPORTS['stage-1']));
  const provenance = (report as { stage1_provenance: { report_path: string; report_sha256: string } }).stage1_provenance;
  if (provenance.report_path !== 'reports/stage-1-proof-report.json' || provenance.report_sha256 !== expectedStage1) {
    return { ok: false, error: 'Stage 2 provenance does not match the retained Stage 1 report' };
  }
  return { ok: true };
}

export function verifyRetainedReports(reportsDir = defaultReportsDir): { ok: true } | { ok: false; error: string } {
  try {
    const manifestPath = join(reportsDir, 'manifest.json');
    if (!existsSync(manifestPath)) return { ok: false, error: 'retained report manifest is missing' };
    const manifest = parseJson(manifestPath) as Manifest;
    const expectedNames = [...Object.values(RETAINED_REPORTS)].sort();
    if (manifest.schema_version !== 1 || !manifest.reports || Object.keys(manifest.reports).sort().join(',') !== expectedNames.join(',')) {
      return { ok: false, error: 'retained report manifest has unknown or missing entries' };
    }
    const actualNames = readdirSync(reportsDir).filter((name) => name.endsWith('.json') && name !== 'manifest.json').sort();
    if (actualNames.join(',') !== expectedNames.join(',')) return { ok: false, error: 'retained reports include unknown or missing files' };
    for (const [selector, filename] of Object.entries(RETAINED_REPORTS) as [RetainedReportSelector, string][]) {
      const path = join(reportsDir, filename);
      const pinned = manifest.reports[filename];
      if (!/^[0-9a-f]{64}$/.test(pinned ?? '')) return { ok: false, error: `manifest hash is invalid for ${filename}` };
      if (sha256File(path) !== pinned) return { ok: false, error: `retained report hash mismatch for ${filename}` };
      const validated = validateRetainedCandidate(selector, parseJson(path), reportsDir);
      if (!validated.ok) return { ok: false, error: `${filename}: ${validated.error}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const result = verifyRetainedReports();
  if (!result.ok) {
    console.error(`retained report verification failed: ${result.error}`);
    process.exit(1);
  }
  console.log('retained report verification passed');
}
