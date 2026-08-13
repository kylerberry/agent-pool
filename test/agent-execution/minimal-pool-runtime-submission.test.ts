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
  it('submits one job with a fake Pi process and records verifier result', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    setupFixture(fixturePath);

    const job = makeJob(fixturePath);
    let persisted: unknown;
    let attemptPersisted = false;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (expectations: PoolProofLaunchExpectations, launcherJob: ProofJob) =>
        createPoolProofPiLauncher({ expectations, job: launcherJob, _testOnlyFakeProcess: makeFakeProcess(job.attemptId, job.nodeId, 'nonce', 'result-1') }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => { attemptPersisted = true; },
      verify: async () => ({ status: 'passed', commitSha: 'abc123', failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } }),
      persistResult: async (r) => { persisted = r; },
    });

    const result = await runtime.submit(job);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, 'passed');
    assert.equal(attemptPersisted, true);
    assert.ok(persisted);
  });

  it('rejects all-real provenance at test-only factory construction', (t) => {
    assert.throws(
      () =>
        createMinimalPoolRuntimeForTest({
          resourceFactory: createAttemptResourceFactory({ runtimeRoot: createTestTempDir(t, 'runtime-') }),
          createPiLauncher: () => ({ launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1') }),
          selectedModel: 'moonshot/kimi-k2.7-code',
          launchIdentity: makeLaunchIdentity(),
          adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
          persistAttempt: async () => {},
          verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: null }),
          persistResult: async () => {},
        }),
      /POOL_PROOF_TEST_RUNTIME_REQUIRES_FAKE_ADAPTER/,
    );
  });

  it('executes explicit fake provenance through the test-only factory', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    const job = makeJob(fixturePath);
    let persisted = false;
    const runtime = createMinimalPoolRuntimeForTest({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => ({
        launch: async () => makeFakeProcess(job.attemptId, job.nodeId, 'nonce', 'result-1'),
      }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'fake', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: null }),
      persistResult: async () => { persisted = true; },
    });

    const result = await runtime.submit(job);
    assert.equal(result.ok, true);
    assert.equal(persisted, true);
  });

  it('runs at most one active attempt at a time', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    let active = 0;
    let maxActive = 0;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => ({
        launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1'),
      }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } };
      },
      persistResult: async () => {},
    });

    const jobs: ProofJob[] = [
      { ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' },
      { ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-2' },
      { ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-3' },
    ];

    const results = await Promise.all(jobs.map((job) => runtime.submit(job)));
    assert.equal(results.every((r) => r.ok), true);
    assert.equal(maxActive, 1, `expected max active 1, got ${maxActive}`);
  });

  it('runs up to two concurrent attempts across persistent slots', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    let active = 0;
    let maxActive = 0;
    let startedFirstTwo = 0;

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
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (job.attemptId === 'att-1' || job.attemptId === 'att-2') {
          startedFirstTwo += 1;
        }
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
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
    assert.equal(results.every((r) => r.ok), true);
    assert.equal(maxActive, 2, `expected max active 2, got ${maxActive}`);
    assert.equal(startedFirstTwo, 2, 'first two jobs must start before either completes');
  });

  it('dispatches the third queued job only after a slot releases', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const order: string[] = [];
    const releaseAtt1 = deferrable();
    const releaseAtt2 = deferrable();

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
        order.push(job.attemptId);
        if (job.attemptId === 'att-1') await releaseAtt1.promise;
        if (job.attemptId === 'att-2') await releaseAtt2.promise;
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

    const allDone = Promise.all(jobs.map((job) => runtime.submit(job)));
    await yieldToEventLoop();
    assert.equal(order.length, 2, 'two slots must start att-1 and att-2 concurrently');
    assert.ok(order.includes('att-1'));
    assert.ok(order.includes('att-2'));
    assert.ok(!order.includes('att-3'), 'att-3 must not start while both slots are busy');

    releaseAtt1.resolve();
    await yieldToEventLoop();
    assert.equal(order.length, 3, 'att-3 must start after a slot releases');
    assert.equal(order[2], 'att-3');

    releaseAtt2.resolve();
    await allDone;
  });

  it('allocates fresh resources for every attempt', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const resources: string[] = [];

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => ({
        launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1'),
      }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async (res) => {
        resources.push(res.workspacePath);
        resources.push(res.piSessionDir);
        resources.push(res.nonce);
        resources.push(res.resultId);
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

    await Promise.all(jobs.map((job) => runtime.submit(job)));
    const unique = new Set(resources);
    assert.equal(unique.size, resources.length, 'all resource identities must be unique across attempts');
  });

  it('rejects duplicate attempt IDs', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
    const release = deferrable();

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
        if (job.attemptId === 'att-1') await release.promise;
        return { status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } };
      },
      persistResult: async () => {},
      slotCount: 2,
    });

    const first = runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' });
    await yieldToEventLoop();
    const duplicate = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, 'POOL_PROOF_DUPLICATE_ATTEMPT_ID');

    release.resolve();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
  });

  it('rejects invalid slotCount values', (t) => {
    for (const bad of [0, -1, 1.5, NaN, 'two']) {
      assert.throws(
        () =>
          createMinimalPoolRuntime({
            resourceFactory: createAttemptResourceFactory({ runtimeRoot: createTestTempDir(t, 'runtime-') }),
            createPiLauncher: () => ({ launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1') }),
            selectedModel: 'moonshot/kimi-k2.7-code',
            launchIdentity: makeLaunchIdentity(),
            adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
            persistAttempt: async () => {},
            verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: null }),
            persistResult: async () => {},
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            slotCount: bad as any,
          }),
        /POOL_PROOF_INVALID_SLOT_COUNT/,
      );
    }
  });
});
