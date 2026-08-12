import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMinimalPoolRuntime,
  createAttemptResourceFactory,
  createPoolProofPiLauncher,
  type ProofJob,
  type PoolProofLaunchExpectations,
  type PiProcess,
} from '../../src/domains/agent-execution/index.ts';
import type { GreenEvidence } from '../../src/domains/verification/pool-proof-verifier.ts';

function deferrable(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function makeJob(fixturePath: string): ProofJob {
  return {
    nodeId: 'single-worker-pool-proof',
    attemptId: 'att://proof/single-worker-pool-proof/1',
    attemptNumber: 1,
    intent: 'test',
    changeSpec: 'test',
    acceptanceCriteria: [{ id: 'c1', text: 'test passes' }],
    criteriaOriginSource: 'direct_task',
    criteriaOriginSourceId: 'test',
    targetRepo: 'single-worker-fixture',
    targetBranch: 'main',
    allowedChangedPaths: ['src/message.js'],
    fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
    workspacePath: fixturePath,
  };
}

function setupFixture(fixturePath: string) {
  mkdirSync(join(fixturePath, 'src'), { recursive: true });
  mkdirSync(join(fixturePath, 'test'), { recursive: true });
  writeFileSync(join(fixturePath, 'src/message.js'), "export function getMessage() { return 'world'; }");
  writeFileSync(
    join(fixturePath, 'test/message.test.js'),
    `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { getMessage } from '../src/message.js'; test('msg', () => assert.equal(getMessage(), 'world'));`,
  );
  writeFileSync(join(fixturePath, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(fixturePath, '.git'), { recursive: true });
  writeFileSync(join(fixturePath, '.git', 'HEAD'), 'abc123');
  writeFileSync(join(fixturePath, '.git', 'HEAD^'), 'base123');
}

function makeFakeProcess(attemptId: string, nodeId: string, nonce: string, resultId: string, overrides?: Partial<PiProcess>): PiProcess {
  return Object.freeze({
    pid: 12345,
    exitCode: 0,
    signalCode: null,
    timedOut: false,
    output: '',
    attemptId,
    nodeId,
    attemptNonce: nonce,
    resultId,
    failureCode: null,
    ...overrides,
  });
}

function makeLaunchIdentity(): PoolProofLaunchExpectations {
  return {
    nodeId: 'single-worker-pool-proof',
    attemptId: 'att://proof/single-worker-pool-proof/1',
    targetRepo: 'single-worker-fixture',
    targetBranch: 'main',
    workspacePath: '/tmp/fake',
    piRuntimeParent: '/tmp/fake/pi',
    piSessionDir: '/tmp/fake/session',
    piExecutablePath: '/opt/pi/pi',
    piExecutableVersion: '0.83.0',
    piExecutableDigest: 'pinned-pi-digest',
    packagePath: '/opt/agent-pool-worker-harness',
    packageProfile: 'pool-proof-builder',
    packageDigest: 'pinned-package-digest',
    profileName: 'pool-proof-builder',
    profilePath: '/opt/agent-pool-worker-harness/profiles/pool-proof-builder',
    profileDigest: 'pinned-profile-digest',
    selectedModel: 'moonshot/kimi-k2.7-code',
    toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
    resultDestinationId: 'result-1',
  };
}

describe('Minimal Pool Runtime', () => {
  it('submits one job with a fake Pi process and records verifier result', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
    const fixturePath = mkdtempSync(join(tmpdir(), 'fixture-'));
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

  it('fails when the Pi launcher rejects the context', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
    const fixturePath = mkdtempSync(join(tmpdir(), 'fixture-'));
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

  it('rejects fake adapters in production mode', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
    const fixturePath = mkdtempSync(join(tmpdir(), 'fixture-'));
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

  it('runs at most one active attempt at a time', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
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
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-3' },
    ];

    const results = await Promise.all(jobs.map((job) => runtime.submit(job)));
    assert.equal(results.every((r) => r.ok), true);
    assert.equal(maxActive, 1, `expected max active 1, got ${maxActive}`);
  });

  it('persists a failed result when the launcher rejects the context', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
    const fixturePath = mkdtempSync(join(tmpdir(), 'fixture-'));
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

  it('runs up to two concurrent attempts across persistent slots', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
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
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-3' },
    ];

    const results = await Promise.all(jobs.map((job) => runtime.submit(job)));
    assert.equal(results.every((r) => r.ok), true);
    assert.equal(maxActive, 2, `expected max active 2, got ${maxActive}`);
    assert.equal(startedFirstTwo, 2, 'first two jobs must start before either completes');
  });

  it('dispatches the third queued job only after a slot releases', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
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
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-3' },
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

  it('allocates fresh resources for every attempt', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
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
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-3' },
    ];

    await Promise.all(jobs.map((job) => runtime.submit(job)));
    const unique = new Set(resources);
    assert.equal(unique.size, resources.length, 'all resource identities must be unique across attempts');
  });

  it('continues unrelated jobs after one attempt fails', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));

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
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' },
      { ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-3' },
    ];

    const results = await Promise.all(jobs.map((job) => runtime.submit(job)));
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, false);
    assert.equal(results[2]?.ok, true);
  });

  it('rejects duplicate attempt IDs', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
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

    const first = runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' });
    await yieldToEventLoop();
    const duplicate = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, 'POOL_PROOF_DUPLICATE_ATTEMPT_ID');

    release.resolve();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
  });

  it('rejects invalid slotCount values', () => {
    for (const bad of [0, -1, 1.5, NaN, 'two']) {
      assert.throws(
        () =>
          createMinimalPoolRuntime({
            resourceFactory: createAttemptResourceFactory({ runtimeRoot: mkdtempSync(join(tmpdir(), 'runtime-')) }),
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

  it('drains queued jobs during shutdown', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
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

    const job1 = runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' });
    const job2 = runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' });
    const job3 = runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-3' });

    await yieldToEventLoop();
    assert.equal(running, 1, 'one slot should be running att-1');

    const shutdownPromise = runtime.shutdown();
    await yieldToEventLoop();
    const late = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-4' });
    assert.equal(late.ok, false);
    assert.equal(late.error, 'POOL_PROOF_RUNTIME_SHUTTING_DOWN');

    release.resolve();
    await shutdownPromise;

    const results = await Promise.all([job1, job2, job3]);
    assert.equal(results.every((r) => r.ok), true);
  });

  it('bounds allocation failure and continues unrelated work', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
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

    const r1 = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' });
    shouldFail = false;
    const r2 = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' });

    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'RESOURCE_ALLOCATION_FAILED');
    assert.ok(r1.errorDetail?.includes('disk full'));
    assert.equal(r2.ok, true);
  });

  it('bounds release failure so the slot is still freed', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));

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

    const r1 = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' });
    assert.equal(r1.ok, true);
    assert.ok(r1.cleanupDisposition?.errors.some((e) => e.includes('cleanup refused')));

    const r2 = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' });
    assert.equal(r2.ok, true);
  });
});

describe('Minimal Pool Runtime — exact-once and immutability (Stage 2 blockers)', () => {
  it('rejects a sequential re-submission of an already-completed attempt id (exact-once)', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => ({ launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1') }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } }),
      persistResult: async () => {},
      slotCount: 2,
    });
    const first = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' });
    assert.equal(first.ok, true);
    // After completion the runtime must retain the attempt id for its lifetime.
    const replay = await runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' });
    assert.equal(replay.ok, false);
    assert.equal(replay.error, 'POOL_PROOF_DUPLICATE_ATTEMPT_ID');
  });

  it('returns runner-owned actual slot assignment evidence in SubmitResult', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-'));
    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => ({ launch: async () => makeFakeProcess('att-1', 'n1', 'nonce', 'r1') }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async () => ({ status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: { command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false } }),
      persistResult: async () => {},
      slotCount: 2,
    });
    const results = await Promise.all([
      runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-1' }),
      runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-2' }),
      runtime.submit({ ...makeJob(mkdtempSync(join(tmpdir(), 'fixture-'))), attemptId: 'att-3' }),
    ]);
    for (const r of results) {
      assert.equal(r.ok, true);
      assert.ok('slotIndex' in r, 'SubmitResult must carry runner-owned slotIndex evidence');
    }
    const slots = new Set(results.map((r) => (r as { slotIndex: number }).slotIndex));
    for (const s of slots) assert.ok(s === 0 || s === 1, `slot index must be 0 or 1, got ${s}`);
  });

  it('returns a frozen PiProcess that cannot be mutated', async () => {
    const fixturePath = mkdtempSync(join(tmpdir(), 'fixture-'));
    setupFixture(fixturePath);
    const job = makeJob(fixturePath);
    let captured: PiProcess | undefined;
    // Pass a MUTABLE fake process so the test verifies the launcher/runtime
    // freezes it, not the test helper.
    const mutableProcess: PiProcess = {
      pid: 12345, exitCode: 0, signalCode: null, timedOut: false, output: '',
      attemptId: job.attemptId, nodeId: job.nodeId, attemptNonce: 'nonce', resultId: 'result-1', failureCode: null,
    };
    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot: mkdtempSync(join(tmpdir(), 'runtime-')) }),
      createPiLauncher: (expectations: PoolProofLaunchExpectations, launcherJob: ProofJob) =>
        createPoolProofPiLauncher({ expectations, job: launcherJob, _testOnlyFakeProcess: mutableProcess }),
      selectedModel: 'moonshot/kimi-k2.7-code',
      launchIdentity: makeLaunchIdentity(),
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async () => {},
      verify: async (_res, _job, process) => { captured = process; return { status: 'passed', commitSha: null, failureCode: null, checks: [], greenEvidence: null }; },
      persistResult: async () => {},
    });
    await runtime.submit(job);
    assert.ok(captured);
    assert.equal(Object.isFrozen(captured), true, 'PiProcess must be frozen by the launcher');
    assert.throws(() => { (captured as { pid: number }).pid = 999; }, /not extensible|read only|cannot be assigned|object is not extensible/i);
  });
});

