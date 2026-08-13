import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateLifecycleReport } from '../src/verify-retained-reports.ts';

const report = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'reports', 'persistent-attempt-sandbox-lifecycle-report.json'), 'utf8'));

test('retained lifecycle report is bounded and contains no raw private data', () => {
  assert.equal(validateLifecycleReport(report).ok, true);
  const serialized = JSON.stringify(report);
  for (const prohibited of ['/Users/', '/tmp/', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'sk-', 'password=', 'docker run']) {
    assert.equal(serialized.includes(prohibited), false, `report leaked ${prohibited}`);
  }
  assert.equal(report.commitments.final_owned_containers, 0);
});
