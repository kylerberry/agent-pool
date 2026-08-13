import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RETAINED_REPORTS, sha256File, validateRetainedCandidate, type RetainedReportSelector } from './verify-retained-reports.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportsDir = join(packageRoot, 'reports');

type Manifest = { schema_version: 1; reports: Record<string, string> };
export type PublishRequest = { readonly reportsDir?: string; readonly selector: string; readonly candidatePath: string; readonly allowSealed?: boolean };

function isSelector(value: string): value is RetainedReportSelector {
  return Object.hasOwn(RETAINED_REPORTS, value);
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation !== '' && !relation.startsWith('..');
}

export function publishRetainedReport(request: PublishRequest): { ok: true } | { ok: false; error: string } {
  try {
    if (!isSelector(request.selector)) return { ok: false, error: 'unknown retained report selector' };
    if ((request.selector === 'stage-1' || request.selector === 'stage-2') && request.allowSealed !== true) {
      return { ok: false, error: 'sealed Stage 1/2 publication requires --allow-sealed' };
    }
    const reportsDir = resolve(request.reportsDir ?? defaultReportsDir);
    const candidate = realpathSync(request.candidatePath);
    const tempRoot = realpathSync(tmpdir());
    if (!isWithin(tempRoot, candidate) || isWithin(reportsDir, candidate) || basename(candidate) !== RETAINED_REPORTS[request.selector]) {
      return { ok: false, error: 'candidate must be a generated temporary report with the approved filename' };
    }
    const report = JSON.parse(readFileSync(candidate, 'utf8'));
    const validated = validateRetainedCandidate(request.selector, report, reportsDir);
    if (!validated.ok) return { ok: false, error: validated.error };

    const manifestPath = join(reportsDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (manifest.schema_version !== 1 || !manifest.reports || Object.keys(manifest.reports).sort().join(',') !== Object.values(RETAINED_REPORTS).sort().join(',')) {
      return { ok: false, error: 'retained report manifest has an unsafe selection' };
    }
    const destination = join(reportsDir, RETAINED_REPORTS[request.selector]);
    copyFileSync(candidate, destination);
    manifest.reports[RETAINED_REPORTS[request.selector]] = sha256File(destination);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const selectorIndex = args.indexOf('--report');
  const candidateIndex = args.indexOf('--candidate');
  const selector = selectorIndex >= 0 ? args[selectorIndex + 1] : undefined;
  const candidatePath = candidateIndex >= 0 ? args[candidateIndex + 1] : undefined;
  if (!selector || !candidatePath) {
    console.error('usage: --report <stage-1|stage-2|sandbox-lifecycle> --candidate <temporary report path> [--allow-sealed]');
    process.exit(1);
  }
  const result = publishRetainedReport({ selector, candidatePath, allowSealed: args.includes('--allow-sealed') });
  if (!result.ok) {
    console.error(`retained report publication failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`published retained ${selector} report`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
