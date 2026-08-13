import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestTempDir } from './test-temp-dir.ts';
import {
  createAttemptResourceFactory,
  createMinimalPoolRuntime,
  createMinimalPoolRuntimeForTest,
  createPoolProofPiLauncher,
  type PoolProofLaunchExpectations,
  type ProofJob,
} from '../../src/domains/agent-execution/index.ts';
import { deferrable, makeFakeProcess, makeJob, makeLaunchIdentity, setupFixture, yieldToEventLoop } from './minimal-pool-runtime.fixtures.ts';

describe('Minimal Pool Runtime', () => {
  it('fails when the Pi launcher rejects the context', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    setupFixture(fixturePath);
    const job = makeJob(fixturePath);

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (expectations: PoolProofLaunchExpectations, launcherJob: ProofJob) =>
        createPoolProofPiLauncher({
          expectations: { ...expectations, nodeId: 'different' },
          job: launcherJob,
        }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: null }),
      persistResult: async () => {},
    });

    const result = await runtime.submit(job);
    assert.equal(result.ok, false);
  });

  it('rejects fake adapters in production mode', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    setupFixture(fixturePath);
    const job = makeJob(fixturePath);

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (expectations: PoolProofLaunchExpectations, launcherJob: ProofJob) =>
        createPoolProofPiLauncher({ expectations, job: launcherJob, _testOnlyFakeProcess: makeFakeProcess(job.attemptId, job.nodeId, 'nonce', 'result-1') }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'fake', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: null }),
      persistResult: async () => {},
    });

    const result = await runtime.submit(job);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('fake'));
  });

  it('persists a failed result when the launcher rejects the context', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    setupFixture(fixturePath);
    const job = makeJob(fixturePath);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let persisted: any = null;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (expectations: PoolProofLaunchExpectations, launcherJob: ProofJob) =>
        createPoolProofPiLauncher({
          expectations: { ...expectations, nodeId: 'different' },
          job: launcherJob,
        }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: null }),
      persistResult: async (r) => {
        persisted = {
          status: r.status,
          commitSha: r.commitSha,
          failureCode: r.failureCode,
          checks: r.checks,
          greenEvidence: r.greenEvidence,
        };
      },
    });

    const result = await runtime.submit(job);
    assert.equal(result.ok, false);
    assert.ok(persisted, 'failed launch must persist a terminal result');
    assert.equal(persisted!.status, 'failed');
    assert.equal(persisted!.commitSha, null);
    assert.ok(persisted!.failureCode && persisted!.failureCode.length > 0);
    assert.equal(persisted!.checks.some((c: { passed: boolean }) => !c.passed), true);
    assert.equal(persisted!.greenEvidence, null);
  });

  it('continues unrelated jobs after one attempt fails', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => ({
        launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1'),
      }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async (_resources, job) => {
        if (job.attemptId === 'att-2') {
          throw new Error('injected failure');
        }
        return { status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } };
      },
      persistResult: async () => {},
      slotCount: 2,
    });

    const jobs: ProofJob[] = [
      { ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' },
      { ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-2' },
      { ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-3' },
    ];

    const results = await Promise.all(jobs.map((job) => runtime.submit(job)));
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, false);
    assert.equal(results[2]?.ok, true);
  });

  it('drains queued jobs during shutdown', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const release = deferrable();
    let running = 0;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => ({
        launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1'),
      }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async (_resources, job) => {
        running += 1;
        if (job.attemptId === 'att-1') await release.promise;
        return { status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } };
      },
      persistResult: async () => {},
      slotCount: 1,
    });

    const job1 = runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' });
    const job2 = runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-2' });
    const job3 = runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-3' });

    await yieldToEventLoop();
    assert.equal(running, 1, 'one slot should be running att-1');

    const shutdownPromise = runtime.shutdown();
    await yieldToEventLoop();
    const late = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-4' });
    assert.equal(late.ok, false);
    assert.equal(late.error, 'POOL_PROOF_RUNTIME_SHUTTING_DOWN');

    release.resolve();
    await shutdownPromise;

    const results = await Promise.all([job1, job2, job3]);
    assert.equal(results.every((r) => r.ok), true);
  });

  it('bounds allocation failure and continues unrelated work', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    let shouldFail = true;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: {
        allocate: (attemptId: string) => {
          if (shouldFail && attemptId === 'att-1') {
            throw new Error('disk full');
          }
          return createAttemptResourceFactory({ runtimeRoot }).allocate(attemptId);
        },
        release: () => ({ attemptRootRemoved: true, workspaceRemoved: true, errors: [] }),
      },
      createPiLauncher: () => ({
        launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1'),
      }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } }),
      persistResult: async () => {},
      slotCount: 1,
    });

    const r1 = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' });
    shouldFail = false;
    const r2 = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-2' });

    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'RESOURCE_ALLOCATION_FAILED');
    assert.ok(r1.errorDetail?.includes('disk full'));
    assert.equal(r2.ok, true);
  });

  it('bounds release failure so the slot is still freed', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');

    const runtime = createMinimalPoolRuntime({
      resourceFactory: {
        allocate: (attemptId: string) => createAttemptResourceFactory({ runtimeRoot }).allocate(attemptId),
        release: () => {
          throw new Error('cleanup refused');
        },
      },
      createPiLauncher: () => ({
        launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1'),
      }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } }),
      persistResult: async () => {},
      slotCount: 1,
    });

    const r1 = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' });
    assert.equal(r1.ok, true);
    assert.ok(r1.cleanupDisposition?.errors.some((e) => e.includes('cleanup refused')));

    const r2 = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-2' });
    assert.equal(r2.ok, true);
  });
});
