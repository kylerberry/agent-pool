import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishRetainedReport } from '../src/publish-retained-report.ts';
import { verifyRetainedReports } from '../src/verify-retained-reports.ts';

const packageRoot = join(import.meta.dirname, '..');
const sourceReports = join(packageRoot, 'reports');

function copyReports(): string {
  const root = mkdtempSync(join(tmpdir(), 'retained-reports-'));
  const reports = join(root, 'reports');
  cpSync(sourceReports, reports, { recursive: true });
  return reports;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('retained reports', () => {
  it('keeps lifecycle Docker evidence outside the ordinary unit lane', () => {
    const scripts = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).scripts as Record<string, string>;
    assert.equal(scripts.test.includes('persistent-attempt-sandbox-lifecycle.test.ts'), false);
    assert.match(scripts['proof:sandbox-lifecycle:run'], /persistent-attempt-sandbox-lifecycle\.test\.ts/);
    assert.match(scripts['proof:reports:verify'], /verify-retained-reports/);
    const rootScripts = JSON.parse(readFileSync(join(packageRoot, '..', '..', 'package.json'), 'utf8')).scripts as Record<string, string>;
    assert.equal(rootScripts['test:all'], 'npm run test:root && npm run test:orchestrator && npm run test:worker && npm run test:pool-proof');
    assert.match(rootScripts['test:docker'], /proof:sandbox-lifecycle/);
  });

  it('verifies retained reports read-only', () => {
    const reports = copyReports();
    const before = ['stage-1-proof-report.json', 'stage-2-proof-report.json', 'persistent-attempt-sandbox-lifecycle-report.json', 'manifest.json']
      .map((name) => [name, sha256(join(reports, name))]);
    assert.deepEqual(verifyRetainedReports(reports), { ok: true });
    const after = before.map(([name]) => [name, sha256(join(reports, name))]);
    assert.deepEqual(after, before);
  });

  it('rejects hash tampering and Stage 2 provenance mismatch', () => {
    const reports = copyReports();
    writeFileSync(join(reports, 'stage-1-proof-report.json'), '{}\n');
    assert.equal(verifyRetainedReports(reports).ok, false);

    const second = copyReports();
    const stage2Path = join(second, 'stage-2-proof-report.json');
    const stage2 = JSON.parse(readFileSync(stage2Path, 'utf8')) as Record<string, any>;
    stage2.stage1_provenance.report_sha256 = '0'.repeat(64);
    writeFileSync(stage2Path, JSON.stringify(stage2));
    const manifestPath = join(second, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { reports: Record<string, string> };
    manifest.reports['stage-2-proof-report.json'] = sha256(stage2Path);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    assert.equal(verifyRetainedReports(second).ok, false);
  });

  it('rejects unknown report selectors and sealed publication without override', () => {
    const reports = copyReports();
    const candidate = join(mkdtempSync(join(tmpdir(), 'stage-1-candidate-')), 'stage-1-proof-report.json');
    writeFileSync(candidate, readFileSync(join(reports, 'stage-1-proof-report.json')));
    const before = sha256(join(reports, 'stage-1-proof-report.json'));
    assert.equal(publishRetainedReport({ reportsDir: reports, selector: 'unknown', candidatePath: candidate }).ok, false);
    assert.equal(publishRetainedReport({ reportsDir: reports, selector: 'stage-1', candidatePath: candidate }).ok, false);
    assert.equal(sha256(join(reports, 'stage-1-proof-report.json')), before);
  });

  it('publishes only an explicit verified lifecycle candidate', () => {
    const reports = copyReports();
    const candidate = join(mkdtempSync(join(tmpdir(), 'lifecycle-candidate-')), 'persistent-attempt-sandbox-lifecycle-report.json');
    writeFileSync(candidate, readFileSync(join(reports, 'persistent-attempt-sandbox-lifecycle-report.json')));
    assert.deepEqual(publishRetainedReport({ reportsDir: reports, selector: 'sandbox-lifecycle', candidatePath: candidate }), { ok: true });
    assert.deepEqual(verifyRetainedReports(reports), { ok: true });
  });
});
