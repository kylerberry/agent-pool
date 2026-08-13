import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestTempDir } from './test-temp-dir.ts';
import {
  createAttemptResourceFactory,
  createMinimalPoolRuntime,
  createMinimalPoolRuntimeForTest,
  createPoolProofPiLauncher,
  type PiProcess,
  type PoolProofLaunchExpectations,
  type ProofJob,
} from '../../src/domains/agent-execution/index.ts';
import { deferrable, makeFakeProcess, makeJob, makeLaunchIdentity, setupFixture, yieldToEventLoop } from './minimal-pool-runtime.fixtures.ts';

describe('Minimal Pool Runtime — exact-once and immutability (Stage 2 blockers)', () => {
  it('rejects a sequential re-submission of an already-completed attempt id (exact-once)', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
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
    const first = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' });
    assert.equal(first.ok, true);
    // After completion the runtime must retain the attempt id for its lifetime.
    const replay = await runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' });
    assert.equal(replay.ok, false);
    assert.equal(replay.error, 'POOL_PROOF_DUPLICATE_ATTEMPT_ID');
  });

  it('returns runner-owned actual slot assignment evidence in SubmitResult', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'runtime-');
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
      runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-1' }),
      runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-2' }),
      runtime.submit({ ...makeJob(createTestTempDir(t, 'fixture-')), attemptId: 'att-3' }),
    ]);
    for (const r of results) {
      assert.equal(r.ok, true);
      assert.ok('slotIndex' in r, 'SubmitResult must carry runner-owned slotIndex evidence');
    }
    const slots = new Set(results.map((r) => (r as { slotIndex: number }).slotIndex));
    for (const s of slots) assert.ok(s === 0 || s === 1, `slot index must be 0 or 1, got ${s}`);
  });

  it('returns a frozen PiProcess that cannot be mutated', async (t) => {
    const fixturePath = createTestTempDir(t, 'fixture-');
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
      resourceFactory: createAttemptResourceFactory({ runtimeRoot: createTestTempDir(t, 'runtime-') }),
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
