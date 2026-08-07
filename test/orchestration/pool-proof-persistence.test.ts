import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createPoolProofPersistence, createSqliteStore } from '../../src/domains/orchestration/index.ts';

describe('Pool Proof Persistence', () => {
  it('records a proof result and checks without evaluator or phase artifacts', async () => {
    const tmpRoot = join(process.cwd(), '.tmp-test');
    mkdirSync(tmpRoot, { recursive: true });
    const runtimeRoot = mkdtempSync(join(tmpRoot, 'pool-proof-store-'));
    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const work = {
      work_id: 'pool-proof-stage-1',
      origin: 'direct_task' as const,
      repo: 'single-worker',
      branch: 'main',
      payload_hash: 'sha256:deadbeef',
      nodes: [
        {
          id: 'single-worker-pool-proof',
          intent: 'Prove one real headless Pool Worker can complete an atomic fixture change.',
          change_spec: 'Change src/message.js so the fixture test passes.',
          acceptance_criteria: [
            'Fixture test fails at base commit.',
            'Only allowed paths change.',
            'Fixture test passes after the attempt commit.',
          ],
          depends_on: [],
          criteria_origin_source: 'direct_task' as const,
          criteria_origin_source_id: 'pool-proof-stage-1',
        },
      ],
    };

    await persistence.importWorkAndCreateAttempt(
      work,
      'single-worker-pool-proof',
      'attempt-1',
      1,
      'result-1',
      { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 },
    );

    await persistence.recordResult({
      attemptId: 'attempt-1',
      resultId: 'result-1',
      nodeId: 'single-worker-pool-proof',
      selectedModel: 'moonshot/kimi-k2.7-code',
      status: 'passed',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      failureCode: null,
      checks: [
        { name: 'process_exit_success', passed: true },
        { name: 'fixture_test_passes', passed: true },
      ],
      startedAt: new Date('2026-08-05T00:00:00Z'),
      finishedAt: new Date('2026-08-05T00:01:00Z'),
    });

    const result = await persistence.getResult('attempt-1');
    assert.ok(result);
    assert.equal(result?.builder_model, 'moonshot/kimi-k2.7-code');
    assert.equal(result?.commit_sha, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(result?.status, 'passed');

    const checks = await persistence.getChecks('attempt-1');
    assert.equal(checks.length, 2);
    assert.equal(checks.find((c) => c.check_name === 'fixture_test_passes')?.passed, 1);

    assert.equal(await persistence.countPhaseArtifactsForAttempt('attempt-1'), 0);
    assert.deepEqual(await persistence.hasConflictingResult('attempt-1', 'result-1'), { hasConflict: false, existingResultId: 'result-1' });
    assert.deepEqual(await persistence.hasConflictingResult('attempt-1', 'other-result'), { hasConflict: true, existingResultId: 'result-1' });

    await store.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it('rejects recording a duplicate proof result', async () => {
    const tmpRoot = join(process.cwd(), '.tmp-test');
    mkdirSync(tmpRoot, { recursive: true });
    const runtimeRoot = mkdtempSync(join(tmpRoot, 'pool-proof-store-dup-'));
    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const work = {
      work_id: 'pool-proof-dup',
      origin: 'direct_task' as const,
      repo: 'single-worker',
      branch: 'main',
      payload_hash: 'sha256:deadbeef',
      nodes: [
        {
          id: 'single-worker-pool-proof',
          intent: 'test',
          change_spec: 'test',
          acceptance_criteria: ['test'],
          depends_on: [],
          criteria_origin_source: 'direct_task' as const,
          criteria_origin_source_id: 'test',
        },
      ],
    };

    await persistence.importWorkAndCreateAttempt(
      work,
      'single-worker-pool-proof',
      'attempt-dup',
      1,
      'result-dup',
      { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 },
    );

    await persistence.recordResult({
      attemptId: 'attempt-dup',
      resultId: 'result-dup',
      nodeId: 'single-worker-pool-proof',
      selectedModel: 'moonshot/kimi-k2.7-code',
      status: 'passed',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      failureCode: null,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    await assert.rejects(
      persistence.recordResult({
        attemptId: 'attempt-dup',
        resultId: 'result-dup-2',
        nodeId: 'single-worker-pool-proof',
        selectedModel: 'moonshot/kimi-k2.7-code',
        status: 'failed',
        commitSha: null,
        failureCode: 'DUPLICATE',
        checks: [{ name: 'ok', passed: false }],
        startedAt: new Date(),
        finishedAt: new Date(),
      }),
      /append-only/,
    );

    await store.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });
});
