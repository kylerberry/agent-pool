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
      /CONFLICTING_PROOF_RESULT/,
    );

    await store.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it('treats identical proof-result replay as an audited no-op', async () => {
    const tmpRoot = join(process.cwd(), '.tmp-test');
    mkdirSync(tmpRoot, { recursive: true });
    const runtimeRoot = mkdtempSync(join(tmpRoot, 'pool-proof-store-replay-'));
    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const work = {
      work_id: 'pool-proof-replay',
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
      'attempt-replay',
      1,
      'result-replay',
      { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 },
    );

    const startedAt = new Date('2026-08-10T00:00:00.000Z');
    const finishedAt = new Date('2026-08-10T00:01:00.000Z');
    const result = {
      attemptId: 'attempt-replay',
      resultId: 'result-replay',
      nodeId: 'single-worker-pool-proof',
      selectedModel: 'moonshot/kimi-k2.7-code' as const,
      status: 'passed' as const,
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      failureCode: null,
      checks: [{ name: 'ok', passed: true }],
      startedAt,
      finishedAt,
    };

    await persistence.recordResult(result);
    await persistence.recordResult(result);

    const stored = await persistence.getResult('attempt-replay');
    assert.equal(stored?.result_id, 'result-replay');
    assert.equal(stored?.status, 'passed');

    await store.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it('inspects three attempts with two successes, one injected failure, and no phase artifacts', async () => {
    const tmpRoot = join(process.cwd(), '.tmp-test');
    mkdirSync(tmpRoot, { recursive: true });
    const runtimeRoot = mkdtempSync(join(tmpRoot, 'pool-proof-store-multi-'));
    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const work = {
      work_id: 'pool-proof-stage-2',
      origin: 'direct_task' as const,
      repo: 'multi-worker-fixture',
      branch: 'main',
      payload_hash: 'sha256:deadbeef',
      nodes: [
        { id: 'job-a', intent: 'a', change_spec: 'a', acceptance_criteria: ['a'], depends_on: [], criteria_origin_source: 'direct_task' as const, criteria_origin_source_id: 'stage-2' },
        { id: 'job-b', intent: 'b', change_spec: 'b', acceptance_criteria: ['b'], depends_on: [], criteria_origin_source: 'direct_task' as const, criteria_origin_source_id: 'stage-2' },
        { id: 'job-c', intent: 'c', change_spec: 'c', acceptance_criteria: ['c'], depends_on: [], criteria_origin_source: 'direct_task' as const, criteria_origin_source_id: 'stage-2' },
      ],
    };

    await persistence.importWorkAndCreateAttempt(work, 'job-a', 'attempt-a', 1, 'result-a', { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 });
    await persistence.importWorkAndCreateAttempt(work, 'job-b', 'attempt-b', 1, 'result-b', { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 });
    await persistence.importWorkAndCreateAttempt(work, 'job-c', 'attempt-c', 1, 'result-c', { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 });

    await persistence.recordResult({
      attemptId: 'attempt-a',
      resultId: 'result-a',
      nodeId: 'job-a',
      selectedModel: 'moonshot/kimi-k2.7-code',
      status: 'passed',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      failureCode: null,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await persistence.recordResult({
      attemptId: 'attempt-b',
      resultId: 'result-b',
      nodeId: 'job-b',
      selectedModel: 'moonshot/kimi-k2.7-code',
      status: 'failed',
      commitSha: null,
      failureCode: 'INJECTED_WORKER_FAILURE',
      checks: [{ name: 'ok', passed: false }],
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await persistence.recordResult({
      attemptId: 'attempt-c',
      resultId: 'result-c',
      nodeId: 'job-c',
      selectedModel: 'moonshot/kimi-k2.7-code',
      status: 'passed',
      commitSha: 'cccccccccccccccccccccccccccccccccccccccc',
      failureCode: null,
      checks: [{ name: 'ok', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    const results = await persistence.getResultsForWork('pool-proof-stage-2');
    assert.equal(results.length, 3);
    assert.equal(results.filter((r) => r.status === 'passed').length, 2);
    assert.equal(results.filter((r) => r.status === 'failed').length, 1);
    assert.equal(results.find((r) => r.attempt_id === 'attempt-b')?.failure_code, 'INJECTED_WORKER_FAILURE');
    assert.equal(results.find((r) => r.attempt_id === 'attempt-b')?.commit_sha, null);
    assert.equal(results.find((r) => r.attempt_id === 'attempt-a')?.commit_sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(results.find((r) => r.attempt_id === 'attempt-c')?.commit_sha, 'cccccccccccccccccccccccccccccccccccccccc');

    const routings = await persistence.getBuilderRoutingsForWork('pool-proof-stage-2');
    assert.equal(routings.length, 3);
    assert.ok(routings.every((r) => r.builder_model === 'moonshot/kimi-k2.7-code'));

    assert.equal(await persistence.countPhaseArtifactsForWork('pool-proof-stage-2'), 0);

    await store.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it('rejects contradictory failed-with-commit results through public and default-pragmas raw writers', async () => {
    const tmpRoot = join(process.cwd(), '.tmp-test');
    mkdirSync(tmpRoot, { recursive: true });
    const runtimeRoot = mkdtempSync(join(tmpRoot, 'pool-proof-terminal-algebra-'));
    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);
    const work = {
      work_id: 'pool-proof-terminal-algebra', origin: 'direct_task' as const, repo: 'single-worker', branch: 'main', payload_hash: 'sha256:deadbeef',
      nodes: [{ id: 'job', intent: 't', change_spec: 't', acceptance_criteria: ['t'], depends_on: [], criteria_origin_source: 'direct_task' as const, criteria_origin_source_id: 'guard' }],
    };
    await persistence.importWorkAndCreateAttempt(work, 'job', 'attempt-terminal-algebra', 1, 'result-terminal-algebra', { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 });
    await assert.rejects(
      persistence.recordResult({
        attemptId: 'attempt-terminal-algebra', resultId: 'result-terminal-algebra', nodeId: 'job', selectedModel: 'moonshot/kimi-k2.7-code',
        status: 'failed', commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', failureCode: 'FAIL', checks: [{ name: 'failed', passed: false }], startedAt: new Date(), finishedAt: new Date(),
      }),
      /terminal result algebra/,
    );
    await store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(runtimeRoot, 'pool-proof.db'));
    assert.throws(
      () => raw.prepare(`INSERT INTO pool_proof_results (attempt_id, result_id, node_id, builder_model, status, commit_sha, failure_code, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'attempt-terminal-algebra', 'raw-result', 'job', 'moonshot/kimi-k2.7-code', 'failed', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'FAIL', new Date().toISOString(), new Date().toISOString(),
      ),
      /CHECK constraint failed/,
    );
    raw.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it('rejects a raw default-pragmas INSERT OR REPLACE on pool_proof_checks (BEFORE INSERT guard)', async () => {
    const tmpRoot = join(process.cwd(), '.tmp-test');
    mkdirSync(tmpRoot, { recursive: true });
    const runtimeRoot = mkdtempSync(join(tmpRoot, 'pool-proof-store-guard-'));
    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const work = {
      work_id: 'pool-proof-guard',
      origin: 'direct_task' as const,
      repo: 'single-worker',
      branch: 'main',
      payload_hash: 'sha256:deadbeef',
      nodes: [
        { id: 'single-worker-pool-proof', intent: 't', change_spec: 't', acceptance_criteria: ['t'], depends_on: [], criteria_origin_source: 'direct_task' as const, criteria_origin_source_id: 'guard' },
      ],
    };

    await persistence.importWorkAndCreateAttempt(work, 'single-worker-pool-proof', 'attempt-guard', 1, 'result-guard', { builder: 'moonshot/kimi-k2.7-code', policyVersion: 1 });
    await persistence.recordResult({
      attemptId: 'attempt-guard',
      resultId: 'result-guard',
      nodeId: 'single-worker-pool-proof',
      selectedModel: 'moonshot/kimi-k2.7-code',
      status: 'passed',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      failureCode: null,
      checks: [{ name: 'fixture_test_passes', passed: true }],
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await store.close();

    // Open a raw DatabaseSync with default pragmas and attempt a hostile
    // INSERT OR REPLACE that would mutate the append-only check row.
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = join(runtimeRoot, 'pool-proof.db');
    const raw = new DatabaseSync(dbPath);
    assert.throws(
      () =>
        raw.prepare('INSERT OR REPLACE INTO pool_proof_checks (attempt_id, check_name, passed) VALUES (?, ?, ?)').run(
          'attempt-guard', 'fixture_test_passes', 0,
        ),
      /append-only/,
    );
    raw.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });
});
