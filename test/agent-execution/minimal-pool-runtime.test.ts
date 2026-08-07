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

function makeFakeProcess(attemptId: string, nodeId: string, nonce: string, resultId: string): PiProcess {
  return Object.freeze({ pid: 12345, exitCode: 0, timedOut: false, kill: () => true, output: '', attemptId, nodeId, attemptNonce: nonce, resultId });
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
});

