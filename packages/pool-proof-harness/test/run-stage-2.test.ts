/**
 * Integrated Stage 2 harness test.
 *
 * Exercises the public runStage2 flow with explicitly fake adapters so no paid
 * model or container runtime is required. The retained report is validated but
 * not written to the production reports directory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendSandboxOutput, SANDBOX_OUTPUT_CAP_BYTES, runStage2, loadAndValidateStage1Report, type Stage2Options, type Stage2AttemptDiagnostic } from '../src/run-stage-2.ts';
import { buildReport, type Stage1ProofReport } from '../src/report.ts';
import { initializeFixtureRepository } from '../src/fixture-repository.ts';
import type { PiProcess, PiLauncher, PoolProofLaunchExpectations, ProofJob, AttemptResources } from '../../../src/domains/agent-execution/index.ts';
import type { GreenEvidence } from '../../../src/domains/verification/pool-proof-verifier.ts';

function makeFakePiProcess(
  attemptId: string,
  exitCode: number | null,
  signalCode: NodeJS.Signals | null,
  failureCode: string | null,
  attemptNonce: string,
  resultId: string,
  output = '',
  timedOut = false,
): PiProcess {
  return {
    pid: 12345,
    exitCode,
    signalCode,
    timedOut,
    output,
    nodeId: `multi-worker-pool-proof-${attemptId.slice(-1)}`,
    attemptId,
    attemptNonce,
    resultId,
    failureCode,
  };
}

function buildFakeStage1Report(): Stage1ProofReport {
  return buildReport({
    nodeId: 'single-worker-pool-proof',
    attemptId: 'single-worker-pool-proof-attempt-1',
    model: 'moonshot/kimi-k2.7-code',
    baseCommit: '0'.repeat(40),
    resultCommit: '1'.repeat(40),
    status: 'passed',
    fakeAdapter: false,
    checks: [{ name: 'fixture_test_passes', passed: true }],
    startedAt: new Date('2026-08-05T00:00:00.000Z'),
    finishedAt: new Date('2026-08-05T00:01:00.000Z'),
    failureCode: null,
    cleanupDisposition: { workspaceRemoved: true, sessionRemoved: true },
    redEvidence: { command: ['node', '--test', 'test/message.test.js'], exitCode: 1, outputArtifact: '' },
    greenEvidence: { command: ['node', '--test', 'test/message.test.js'], exitCode: 0, outputArtifact: '' },
  });
}

function writeStage1Report(dir: string, report: Stage1ProofReport): string {
  const path = join(dir, 'stage-1-proof-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

function git(workspacePath: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync('git', args, {
    cwd: workspacePath,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      GIT_AUTHOR_NAME: 'Proof',
      GIT_AUTHOR_EMAIL: 'proof@agent-pool.local',
      GIT_COMMITTER_NAME: 'Proof',
      GIT_COMMITTER_EMAIL: 'proof@agent-pool.local',
    },
  });
}

async function runFixtureTestInWorkspace(workspacePath: string): Promise<GreenEvidence> {
  const result = spawnSync('node', ['--test', 'test/message.test.js'], {
    cwd: workspacePath,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  return {
    command: ['node', '--test', 'test/message.test.js'],
    exitCode: result.status ?? 1,
    stdout: result.stdout.slice(0, 4096),
    stderr: result.stderr.slice(0, 4096),
    timedOut: false,
  };
}

describe('Stage 2 harness integration', () => {
  it('bounds high-volume sandbox stream output during receipt and records truncation', () => {
    const first = appendSandboxOutput('', Buffer.alloc(SANDBOX_OUTPUT_CAP_BYTES * 4, 0x78));
    assert.equal(Buffer.byteLength(first.value), SANDBOX_OUTPUT_CAP_BYTES);
    assert.equal(first.truncated, true);
    const second = appendSandboxOutput(first.value, Buffer.alloc(1024, 0x79));
    assert.equal(Buffer.byteLength(second.value), SANDBOX_OUTPUT_CAP_BYTES);
    assert.equal(second.truncated, true);
  });
  it('composes two slots, three jobs, one injected failure, and produces a valid report', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-integration-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });

    const { baseCommit } = initializeFixtureRepository(fixtureSourcePath);
    const stage1Path = writeStage1Report(reportsDir, buildFakeStage1Report());

    const gate = loadAndValidateStage1Report(stage1Path);
    assert.equal(gate.ok, true);

    const faultAttemptId = 'multi-worker-pool-proof-attempt-b';

    const options: Stage2Options = {
      stage1ReportPath: stage1Path,
      stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: 'git',
      },
      model: 'moonshot/kimi-k2.7-code',
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'fake', persistence: 'fake' },
      injectFaultAttemptId: faultAttemptId,
      fixtureSourcePath,
      adapterOverrides: {
        runBaseRed: async () => ({
          command: ['node', '--test', 'test/message.test.js'],
          exitCode: 1,
          stdout: '',
          stderr: '',
          timedOut: false,
        }),
        createPiLauncher: (expectations: PoolProofLaunchExpectations, job: ProofJob): PiLauncher => ({
          launch: async (marker: unknown) => {
            const isFault = job.attemptId === faultAttemptId;
            const nonce = typeof marker === 'object' && marker !== null && 'attempt_nonce' in marker
              ? String((marker as Record<string, unknown>).attempt_nonce)
              : 'nonce';
            return makeFakePiProcess(
              job.attemptId,
              isFault ? 1 : 0,
              isFault ? 'SIGTERM' : null,
              isFault ? 'INJECTED_WORKER_FAILURE' : null,
              nonce,
              expectations.resultDestinationId,
            );
          },
        }),
        verify: async (resources: AttemptResources, job: ProofJob, process: PiProcess) => {
          const isFault = job.attemptId === faultAttemptId;
          if (isFault) {
            return {
              status: 'failed' as const,
              commitSha: null,
              failureCode: 'INJECTED_WORKER_FAILURE',
              checks: [
                { name: 'process_exit_success', passed: false },
                { name: 'injected_worker_failure', passed: false },
              ],
              greenEvidence: null,
            };
          }

          // Make a real deterministic commit in the cloned workspace.
          const messagePath = join(resources.workspacePath, 'src', 'message.js');
          writeFileSync(messagePath, "export function getMessage() {\n  return 'world';\n}\n");
          git(resources.workspacePath, ['add', '.']);
          const commit = git(resources.workspacePath, ['commit', '-m', `stage2 integration commit for ${job.attemptId}`, '--date', `2026-08-06T00:00:00+00:0${job.attemptId.slice(-1)}`]);
          assert.equal(commit.status, 0, `commit failed: ${commit.stderr}`);

          const commitSha = String(git(resources.workspacePath, ['rev-parse', 'HEAD']).stdout).trim();
          assert.ok(/^[0-9a-f]{40}$/.test(commitSha));

          const fixtureEvidence = await runFixtureTestInWorkspace(resources.workspacePath);

          return {
            status: 'passed' as const,
            commitSha,
            failureCode: null,
            checks: [
              { name: 'process_exit_success', passed: true },
              { name: 'process_attempt_binding', passed: process.attemptId === job.attemptId },
              { name: 'process_nonce_binding', passed: process.attemptNonce === resources.nonce },
              { name: 'process_result_binding', passed: process.resultId === resources.resultId },
              { name: 'workspace_contained', passed: true },
              { name: 'expected_parent', passed: true },
              { name: 'exactly_one_commit', passed: true },
              { name: 'allowed_paths_only', passed: true },
              { name: 'clean_tree', passed: true },
              { name: 'fixture_test_passes', passed: fixtureEvidence.exitCode === 0 },
              { name: 'isolation_probes_pass', passed: true },
              { name: 'no_conflicting_result', passed: true },
            ],
            greenEvidence: fixtureEvidence,
          };
        },
      },
    };

    const result = await runStage2(options);
    assert.equal(result.ok, true, `Stage 2 failed: ${!result.ok ? result.reason : ''}`);
    if (!result.ok) return;

    const report = result.report;
    assert.equal(report.slot_count, 2);
    assert.equal(report.attempts.length, 3);

    const passed = report.attempts.filter((a) => a.status === 'passed');
    const failed = report.attempts.filter((a) => a.status === 'failed');
    assert.equal(passed.length, 2);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.failure_code, 'INJECTED_WORKER_FAILURE');

    const passedCommits = new Set(passed.map((a) => a.commit_sha));
    assert.equal(passedCommits.size, 2, 'passed attempts must have distinct commit SHAs');

    const workspaces = new Set(report.attempts.map((a) => a.isolation.workspace_commitment));
    assert.equal(workspaces.size, 3, 'each attempt must have a unique workspace');

    const nonces = new Set(report.attempts.map((a) => a.isolation.nonce_commitment));
    assert.equal(nonces.size, 3, 'each attempt must have a unique nonce');

    const resultIds = new Set(report.attempts.map((a) => a.isolation.result_id_commitment));
    assert.equal(resultIds.size, 3, 'each attempt must have a unique result_id');

    assert.ok(report.next_follow_up.toLowerCase().includes('agent-pool dogfood'));
    assert.ok(report.residual_warning.length > 0);

    // Primary hostile evidence mutates runner-owned facts immediately before
    // aggregate validation, rather than editing an already-derived report.
    const resourceFields = ['workspace', 'piSession', 'nonce', 'resultId', 'repositoryInstance', 'privateRuntime', 'broker', 'inventory', 'resourceAttemptId'] as const;
    const nestedFields = [
      ['executionContext', 'node_id'], ['executionContext', 'attempt_id'], ['executionContext', 'workspace_path'], ['executionContext', 'pi_session_dir'], ['executionContext', 'pi_runtime_parent'], ['executionContext', 'attempt_nonce'], ['executionContext', 'result_destination'],
      ['actorIdentity', 'actor'], ['actorIdentity', 'authority'], ['actorIdentity', 'node_id'], ['actorIdentity', 'attempt_id'], ['actorIdentity', 'target_repo'], ['actorIdentity', 'target_branch'], ['actorIdentity', 'context_source'], ['actorIdentity', 'can_modify_pool_policy'],
      ['attemptContract', 'node_id'], ['attemptContract', 'attempt_id'], ['attemptContract', 'target_repo'], ['attemptContract', 'target_branch'],
    ] as const;
    const assertRejected = async (name: string, mutate: (first: Record<string, any>, second: Record<string, any>, third: Record<string, any>) => readonly unknown[]) => {
      const result = await runStage2({ ...options, mutateRawObservationsForTest: (observations) => {
        const [first, second, third] = observations as readonly Record<string, any>[];
        if (!first || !second || !third) throw new Error('expected observations');
        return mutate(first, second, third) as typeof observations;
      }});
      assert.equal(result.ok, false, `${name} must fail`);
      if (!result.ok) assert.equal(result.failureCode, 'STAGE2_ISOLATION_INVALID');
    };
    for (const field of resourceFields) {
      await assertRejected(`raw reuse of ${field}`, (first, second, third) => [first, { ...second, [field]: first[field] }, third]);
      await assertRejected(`raw swap of ${field}`, (first, second, third) => [{ ...first, [field]: second[field] }, { ...second, [field]: first[field] }, third]);
    }
    for (const [owner, field] of nestedFields) {
      await assertRejected(`nested ${owner}.${field} reuse`, (first, second, third) => {
        const value = first[owner][field] === second[owner][field] ? `HOSTILE_${owner}_${field}` : first[owner][field];
        return [first, { ...second, [owner]: { ...second[owner], [field]: value } }, third];
      });
      await assertRejected(`nested ${owner}.${field} swap`, (first, second, third) => {
        // Constant authority fields cannot form a distinguishable cross-attempt
        // swap, so inject a distinct value to prove their binding check too.
        if (first[owner][field] === second[owner][field]) return [first, { ...second, [owner]: { ...second[owner], [field]: `HOSTILE_${owner}_${field}` } }, third];
        return [{ ...first, [owner]: { ...first[owner], [field]: second[owner][field] } }, { ...second, [owner]: { ...second[owner], [field]: first[owner][field] } }, third];
      });
    }
    // Successful A/C commit reuse and swap must fail against the independently
    // captured persisted verdict, even though both values look valid in isolation.
    await assertRejected('A/C verifier commit reuse', (first, second, third) => [first, second, { ...third, verifier: { ...third.verifier, commitSha: first.verifier.commitSha } }]);
    await assertRejected('A/C verifier commit swap', (first, second, third) => [{ ...first, verifier: { ...first.verifier, commitSha: third.verifier.commitSha } }, second, { ...third, verifier: { ...third.verifier, commitSha: first.verifier.commitSha } }]);
    await assertRejected('allocator versus persisted result ID drift', (first, second, third) => [first, { ...second, persisted: { ...second.persisted, resultId: first.persisted.resultId } }, third]);
    await assertRejected('verifier versus persisted commit drift', (first, second, third) => [first, { ...second, verifier: { ...second.verifier, commitSha: first.verifier.commitSha } }, third]);
    await assertRejected('verifier versus persisted status drift', (first, second, third) => [{ ...first, verifier: { ...first.verifier, status: 'failed' } }, second, third]);
    await assertRejected('verifier versus persisted failure drift', (first, second, third) => [{ ...first, verifier: { ...first.verifier, failureCode: 'INJECTED_WORKER_FAILURE' } }, second, third]);
    await assertRejected('verifier versus persisted checks drift', (first, second, third) => [{ ...first, verifier: { ...first.verifier, checks: [{ name: 'drift', passed: false }] } }, second, third]);
  });

  it('rejects fake adapters in production mode (no overrides)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-prod-reject-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });

    initializeFixtureRepository(fixtureSourcePath);
    const stage1Path = writeStage1Report(reportsDir, buildFakeStage1Report());

    const result = await runStage2({
      stage1ReportPath: stage1Path,
      stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: 'git',
      },
      model: 'moonshot/kimi-k2.7-code',
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'fake', persistence: 'fake' },
      injectFaultAttemptId: 'multi-worker-pool-proof-attempt-b',
      fixtureSourcePath,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'POOL_PROOF_FAKE_ADAPTER_REJECTED');
  });

  it('gates before side effects when Stage 1 report is hostile', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-gate-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });

    initializeFixtureRepository(fixtureSourcePath);

    // Hostile report: fake_adapter=true should be rejected before fixture/runtime/DB creation.
    const hostileReport = buildFakeStage1Report();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (hostileReport as any).fake_adapter = true;
    const stage1Path = writeStage1Report(reportsDir, hostileReport);

    const result = await runStage2({
      stage1ReportPath: stage1Path,
      stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: 'git',
      },
      model: 'moonshot/kimi-k2.7-code',
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      injectFaultAttemptId: 'multi-worker-pool-proof-attempt-b',
      fixtureSourcePath,
      adapterOverrides: {
        runBaseRed: async () => ({ command: ['node'], exitCode: 1, stdout: '', stderr: '', timedOut: false }),
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'STAGE_1_GATE_FAILED');
    assert.ok(result.reason.includes('fake_adapter'));

    // No runtime root or DB should have been created.
    assert.equal(existsSync(join(tmpRoot, 'pool-proof-stage2-runtime-')), false);
  });

  it('observes zero fixture, store, resource, preflight, and adapter effects for every hostile Stage 1 report', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-gate-observable-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    initializeFixtureRepository(fixtureSourcePath);
    const hostileReports: Array<{ name: string; content: string | null }> = [
      { name: 'missing', content: null },
      { name: 'malformed', content: '{not json' },
      { name: 'failed', content: JSON.stringify({ ...buildFakeStage1Report(), status: 'failed' }) },
      { name: 'fake', content: JSON.stringify({ ...buildFakeStage1Report(), fake_adapter: true }) },
      { name: 'incomplete-check', content: JSON.stringify({ ...buildFakeStage1Report(), verifier_checks: [] }) },
      { name: 'bad-cleanup', content: JSON.stringify({ ...buildFakeStage1Report(), cleanup_disposition: { workspace_removed: false, session_removed: true } }) },
      { name: 'unapproved-model', content: JSON.stringify({ ...buildFakeStage1Report(), model: 'unapproved/model' }) },
    ];
    for (const hostile of hostileReports) {
      const stage1Path = join(reportsDir, `${hostile.name}.json`);
      if (hostile.content !== null) writeFileSync(stage1Path, hostile.content);
      const calls: Record<string, number> = { fixture: 0, store: 0, resource: 0, preflight: 0, adapter: 0 };
      const result = await runStage2({
        stage1ReportPath: stage1Path,
        stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
        preflight: {
          pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
          package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
          profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
          sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true }, gitPath: 'git',
        },
        model: 'moonshot/kimi-k2.7-code', containerRuntime: 'docker', sandboxImage: 'sha256:fake',
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'fake', persistence: 'fake' },
        injectFaultAttemptId: 'multi-worker-pool-proof-attempt-b', fixtureSourcePath,
        sideEffectObserver: (effect) => { calls[effect] += 1; },
      });
      assert.equal(result.ok, false, `${hostile.name} must fail the gate`);
      assert.deepEqual(calls, { fixture: 0, store: 0, resource: 0, preflight: 0, adapter: 0 }, `${hostile.name} created a gated effect`);
    }
  });

  it('rejects all-real provenance with raw observation mutation before any side effect', async () => {
    const result = await runStage2({
      stage1ReportPath: '/does-not-matter-after-gate', stage2ReportPath: '/does-not-write',
      preflight: { pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) }, package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) }, profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) }, sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true }, gitPath: 'git' },
      model: 'moonshot/kimi-k2.7-code', containerRuntime: 'docker', sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' }, injectFaultAttemptId: 'multi-worker-pool-proof-attempt-b', fixtureSourcePath: '/does-not-matter',
      mutateRawObservationsForTest: (observations) => observations,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failureCode, 'STAGE_1_GATE_FAILED', 'the Stage 1 gate must remain first');

    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-real-raw-mutation-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    initializeFixtureRepository(fixtureSourcePath);
    const stage1Path = writeStage1Report(reportsDir, buildFakeStage1Report());
    const gated = await runStage2({
      stage1ReportPath: stage1Path, stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: { pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) }, package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) }, profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) }, sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true }, gitPath: 'git' },
      model: 'moonshot/kimi-k2.7-code', containerRuntime: 'docker', sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' }, injectFaultAttemptId: 'multi-worker-pool-proof-attempt-b', fixtureSourcePath,
      mutateRawObservationsForTest: (observations) => observations,
    });
    assert.equal(gated.ok, false);
    if (!gated.ok) assert.equal(gated.failureCode, 'POOL_PROOF_REAL_RAW_MUTATION_REJECTED');
  });

  it('rejects all-real provenance with adapter overrides (overrides require fake)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-real-override-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });

    initializeFixtureRepository(fixtureSourcePath);
    const stage1Path = writeStage1Report(reportsDir, buildFakeStage1Report());

    const result = await runStage2({
      stage1ReportPath: stage1Path,
      stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: 'git',
      },
      model: 'moonshot/kimi-k2.7-code',
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      injectFaultAttemptId: 'multi-worker-pool-proof-attempt-b',
      fixtureSourcePath,
      adapterOverrides: {
        runBaseRed: async () => ({ command: ['node'], exitCode: 1, stdout: '', stderr: '', timedOut: false }),
        createPiLauncher: (): PiLauncher => ({ launch: async () => makeFakePiProcess('x', 0, null, null, 'n', 'r') }),
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'POOL_PROOF_REAL_ADAPTER_OVERRIDE_REJECTED');
  });

  it('diagnostics: captures only runner-owned PiProcess exit fields by attempt ID', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-diag-verify-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    initializeFixtureRepository(fixtureSourcePath);
    const stage1Path = writeStage1Report(reportsDir, buildFakeStage1Report());

    const result = await runStage2({
      stage1ReportPath: stage1Path,
      stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: 'git',
      },
      model: 'moonshot/kimi-k2.7-code',
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'fake', persistence: 'fake' },
      injectFaultAttemptId: 'none',
      fixtureSourcePath,
      adapterOverrides: {
        runBaseRed: async () => ({ command: ['node'], exitCode: 1, stdout: '', stderr: '', timedOut: false }),
        createPiLauncher: (expectations: PoolProofLaunchExpectations, job: ProofJob): PiLauncher => ({
          launch: async (marker: unknown) => {
            const nonce = typeof marker === 'object' && marker !== null && 'attempt_nonce' in marker
              ? String((marker as Record<string, unknown>).attempt_nonce)
              : 'nonce';
            const process = job.attemptId.endsWith('-a')
              ? { exitCode: 17, signalCode: null, timedOut: false }
              : job.attemptId.endsWith('-b')
                ? { exitCode: null, signalCode: 'SIGTERM' as const, timedOut: false }
                : { exitCode: 124, signalCode: null, timedOut: true };
            return makeFakePiProcess(
              job.attemptId,
              process.exitCode,
              process.signalCode,
              null,
              nonce,
              expectations.resultDestinationId,
              'PI_PROCESS_OUTPUT_MUST_NOT_BE_RETAINED',
              process.timedOut,
            );
          },
        }),
        verify: async (_resources: AttemptResources, job: ProofJob, _process: PiProcess) => ({
          status: 'failed' as const,
          commitSha: null,
          failureCode: 'VERIFIER_CHECK_FAILED',
          checks: [
            { name: 'process_exit_success', passed: true },
            { name: 'fixture_test_passes', passed: false },
          ],
          greenEvidence: null,
        }),
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'STAGE2_OUTCOME_MISMATCH');
    const diags = result.attempt_diagnostics ?? [];
    assert.equal(diags.length, 3);
    for (const d of diags) {
      assert.equal(d.submit_ok, true, `${d.attempt_id} should have submit_ok=true`);
      assert.equal(d.submit_status, 'failed', `${d.attempt_id} should have submit_status=failed`);
      assert.equal(d.persisted_status, 'failed', `${d.attempt_id} should have persisted_status=failed`);
      assert.equal(d.persisted_failure_code, 'VERIFIER_CHECK_FAILED');
      assert.equal(d.persisted_result_present, true);
      assert.ok(d.verifier_checks.length > 0);
      assert.equal(d.verifier_checks.some((c) => c.name === 'fixture_test_passes' && !c.passed), true);
      const expectedProcess = d.attempt_id.endsWith('-a')
        ? { exit_code: 17, signal_code: null, timed_out: false, pid_present: true }
        : d.attempt_id.endsWith('-b')
          ? { exit_code: null, signal_code: 'SIGTERM', timed_out: false, pid_present: true }
          : { exit_code: 124, signal_code: null, timed_out: true, pid_present: true };
      assert.deepEqual(d.process, expectedProcess);
      assert.deepEqual(Object.keys(d.process ?? {}).sort(), ['exit_code', 'pid_present', 'signal_code', 'timed_out']);
    }
    assert.ok(!JSON.stringify(diags).includes('PI_PROCESS_OUTPUT_MUST_NOT_BE_RETAINED'));
  });

  it('diagnostics: all three launcher rejections (submit failures)', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-diag-launch-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    initializeFixtureRepository(fixtureSourcePath);
    const stage1Path = writeStage1Report(reportsDir, buildFakeStage1Report());

    const result = await runStage2({
      stage1ReportPath: stage1Path,
      stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: 'git',
      },
      model: 'moonshot/kimi-k2.7-code',
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'fake', persistence: 'fake' },
      injectFaultAttemptId: 'none',
      fixtureSourcePath,
      adapterOverrides: {
        runBaseRed: async () => ({ command: ['node'], exitCode: 1, stdout: '', stderr: '', timedOut: false }),
        createPiLauncher: (_expectations: PoolProofLaunchExpectations, job: ProofJob): PiLauncher => ({
          launch: async () => ({ code: 'LAUNCHER_REJECTED_CONTEXT', reason: `context mismatch for ${job.attemptId}`, toJSON: () => ({ code: 'LAUNCHER_REJECTED_CONTEXT', reason: `context mismatch for ${job.attemptId}` }) }),
        }),
        verify: async () => ({
          status: 'passed' as const, commitSha: 'f'.repeat(40), failureCode: null,
          checks: [{ name: 'stub', passed: true }], greenEvidence: null,
        }),
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'STAGE2_OUTCOME_MISMATCH');
    const diags = result.attempt_diagnostics ?? [];
    assert.equal(diags.length, 3);
    for (const d of diags) {
      assert.equal(d.submit_ok, false, `${d.attempt_id} should have submit_ok=false`);
      assert.equal(d.submit_status, null);
      assert.equal(d.submit_error, 'LAUNCHER_REJECTED_CONTEXT');
      assert.equal(d.persisted_result_present, true, `${d.attempt_id} should have a persisted failed result`);
    }
  });

  it('diagnostics: errorDetail redaction caps at 300 chars and redacts secrets and paths', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'stage2-diag-redact-'));
    const fixtureSourcePath = join(tmpRoot, 'fixture-source');
    const reportsDir = join(tmpRoot, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    initializeFixtureRepository(fixtureSourcePath);
    const stage1Path = writeStage1Report(reportsDir, buildFakeStage1Report());

    const secretDetail = `MOONSHOT_API_KEY=sk-test1234567890abcdef0000 at /Users/kylerberry/Projects/agent-pool/data ${'X'.repeat(400)}`;

    const result = await runStage2({
      stage1ReportPath: stage1Path,
      stage2ReportPath: join(reportsDir, 'stage-2-proof-report.json'),
      preflight: {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: 'git',
      },
      model: 'moonshot/kimi-k2.7-code',
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'fake', persistence: 'fake' },
      injectFaultAttemptId: 'none',
      fixtureSourcePath,
      adapterOverrides: {
        runBaseRed: async () => ({ command: ['node'], exitCode: 1, stdout: '', stderr: '', timedOut: false }),
        createPiLauncher: (expectations: PoolProofLaunchExpectations, job: ProofJob): PiLauncher => ({
          launch: async (marker: unknown) => {
            const nonce = typeof marker === 'object' && marker !== null && 'attempt_nonce' in marker
              ? String((marker as Record<string, unknown>).attempt_nonce)
              : 'nonce';
            return makeFakePiProcess(job.attemptId, 0, null, null, nonce, expectations.resultDestinationId);
          },
        }),
        verify: async () => {
          throw new Error(secretDetail);
        },
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    const diags = result.attempt_diagnostics ?? [];
    assert.equal(diags.length, 3);
    for (const d of diags) {
      assert.equal(d.submit_ok, false);
      assert.equal(d.submit_error, 'RUNTIME_EXCEPTION');
      assert.ok(d.error_detail !== null, `${d.attempt_id} should have error_detail`);
      const detail = d.error_detail!;
      assert.ok(detail.length <= 301, `detail too long: ${detail.length}`);
      assert.ok(!detail.includes('sk-test'), 'API key not redacted');
      assert.ok(!detail.includes('/Users/'), 'absolute path not redacted');
      assert.ok(detail.includes('[REDACTED]'), 'should contain redaction marker for secret');
      assert.ok(detail.includes('[REDACTED_PATH]'), 'should contain redaction marker for path');
      assert.ok(detail.endsWith('…'), 'should be truncated');
    }
  });
});
