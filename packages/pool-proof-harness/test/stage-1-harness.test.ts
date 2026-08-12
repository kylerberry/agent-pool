import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, realpathSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeFixtureRepository, loadFixtureManifest } from '../src/fixture-repository.ts';
import { buildStage1Job } from '../src/stage-1-job.ts';
import { createSqliteStore, createPoolProofPersistence } from '../../../src/domains/orchestration/index.ts';
import {
  createMinimalPoolRuntime,
  createAttemptResourceFactory,
  createPoolProofPiLauncher,
  type PoolProofLaunchExpectations,
  type PackageProfileVerifier,
} from '../../../src/domains/agent-execution/index.ts';
import { createPoolProofVerifier } from '../../../src/domains/verification/pool-proof-verifier.ts';
import type { ProofJob } from '../../../src/domains/agent-execution/index.ts';
import type { ApprovedModelId } from '../../../src/domains/model-routing-and-evaluation/approved-models.ts';
import type { GreenEvidence } from '../../../src/domains/verification/pool-proof-verifier.ts';
import { isValidBaseRed, cleanupAttemptResources } from '../src/run-stage-1.ts';

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digestDirectory(dir: string): string {
  const hash = createHash('sha256');
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      hash.update(`dir:${entry}\n`);
      hash.update(digestDirectory(full));
    } else {
      hash.update(`file:${entry}\n`);
      hash.update(readFileSync(full));
    }
  }
  return hash.digest('hex');
}

type IdentityDirs = {
  packagePath: string;
  profilePath: string;
  packageDigest: string;
  profileDigest: string;
  verify: PackageProfileVerifier;
};

function makeIdentityDirs(root: string): IdentityDirs {
  const packagePath = join(root, 'pkg');
  const profilePath = join(root, 'profile');
  mkdirSync(join(packagePath, 'lib'), { recursive: true });
  mkdirSync(join(profilePath, 'extensions'), { recursive: true });
  mkdirSync(join(profilePath, 'agents'), { recursive: true });
  writeFileSync(join(packagePath, 'package.json'), JSON.stringify({ name: 'agent-pool-worker-harness' }));
  writeFileSync(join(packagePath, 'lib', 'broker.mjs'), 'export default function broker() {}');
  writeFileSync(
    join(profilePath, 'profile.json'),
    JSON.stringify({
      name: 'pool-proof-builder',
      actor: 'pool-worker',
      agents: ['./agents/pool-proof-builder.md'],
      extensions: ['./extensions/trusted-bootstrap.ts'],
    }),
  );
  writeFileSync(
    join(profilePath, 'agents', 'pool-proof-builder.md'),
    `---\nname: pool-proof-builder\nsystemPromptMode: replace\n---\n\nYou are the pool-proof-builder Pool Worker agent.`,
  );
  writeFileSync(join(profilePath, 'extensions', 'trusted-bootstrap.ts'), 'export default function bootstrap() {}');

  const packageDigest = digestDirectory(packagePath);
  const profileDigest = digestDirectory(profilePath);

  return {
    packagePath,
    profilePath,
    packageDigest,
    profileDigest,
    verify: (_pkgPath: string, expectedPkgDigest: string, _profilePath: string, expectedProfileDigest: string) =>
      digestDirectory(packagePath) === expectedPkgDigest && digestDirectory(profilePath) === expectedProfileDigest,
  };
}

function makeFakePiScript(runtimeRoot: string): string {
  const script = join(runtimeRoot, 'fake-pi');
  const code = `#!${process.execPath}
console.log(JSON.stringify({ done: true }));
process.exit(0);
`;
  writeFileSync(script, code, { mode: 0o700 });
  return script;
}

describe('Stage 1 harness', () => {
  it('initializes a deterministic fixture repository with a base commit', () => {
    const target = mkdtempSync(join(tmpdir(), 'pool-proof-fixture-test-'));
    const { manifest, baseCommit } = initializeFixtureRepository(target);
    assert.ok(baseCommit.length > 0);
    assert.equal(manifest.fixture_name, 'single-worker');
    assert.equal(existsSync(join(target, '.git')), true);
    assert.equal(existsSync(join(target, 'src', 'message.js')), true);
  });

  it('builds an ADR-028-shaped job from the fixture', () => {
    const manifest = loadFixtureManifest();
    const job = buildStage1Job(manifest, 'base123', 'node-1', 'attempt-1');
    assert.equal(job.nodeId, 'node-1');
    assert.equal(job.attemptId, 'attempt-1');
    assert.equal(job.criteriaOriginSource, 'direct_task');
    assert.deepEqual(job.allowedChangedPaths, ['src/message.js']);
  });

  it('binds the initialized fixture as the job workspace', () => {
    const manifest = loadFixtureManifest();
    const fixturePath = '/tmp/pool-proof-fixture';
    const job = buildStage1Job(manifest, 'base123', 'node-1', 'attempt-1', fixturePath);
    assert.equal(job.workspacePath, fixturePath);
  });

  it('rejects a timed-out or zero-exit base-red as invalid', () => {
    assert.equal(isValidBaseRed({ command: ['node'], exitCode: 1, stdout: '', stderr: '', timedOut: false }), true);
    assert.equal(isValidBaseRed({ command: ['node'], exitCode: 124, stdout: '', stderr: '', timedOut: true }), false);
    assert.equal(isValidBaseRed({ command: ['node'], exitCode: 0, stdout: '', stderr: '', timedOut: false }), false);
  });

  it('cleans up private runtime and fixture directories', async () => {
    const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-cleanup-')));
    const fixtureTemp = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-fixture-cleanup-')));
    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });

    assert.equal(existsSync(runtimeRoot), true);
    assert.equal(existsSync(fixtureTemp), true);

    await cleanupAttemptResources(store, runtimeRoot, fixtureTemp);

    assert.equal(existsSync(runtimeRoot), false);
    assert.equal(existsSync(fixtureTemp), false);
  });

  it('uses one canonical fixture path for launcher, broker, verifier, and cleanup', async () => {
    const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-runtime-')));
    const fixtureTemp = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-fixture-')));
    const { manifest, baseCommit } = initializeFixtureRepository(fixtureTemp);

    const nodeId = 'single-worker-pool-proof';
    const attemptId = 'single-worker-pool-proof-attempt-1';
    const job = buildStage1Job(manifest, baseCommit, nodeId, attemptId, fixtureTemp);
    const model = 'moonshot/kimi-k2.7-code' as ApprovedModelId;

    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    let capturedLauncherWorkspace: string | undefined;
    let capturedBrokerWorkspace: string | undefined;
    let capturedVerifierWorkspace: string | undefined;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (expectations, runtimeJob) => {
        capturedLauncherWorkspace = expectations.workspacePath;
        capturedBrokerWorkspace = fixtureTemp;
        return createPoolProofPiLauncher({
          expectations,
          job: runtimeJob,
          brokerOptions: {
            socketPath: join(runtimeRoot, 'broker.sock'),
            workspacePath: fixtureTemp,
            containerRuntime: 'docker',
            image: 'sha256:' + 'f'.repeat(64),
            cpuLimit: '1',
            memoryLimit: '1g',
            pidsLimit: 64,
          },
          _testOnlyFakeProcess: {
            pid: 12345,
            exitCode: 0,
            signalCode: null,
            timedOut: false,
            output: '',
            nodeId,
            attemptId,
            attemptNonce: 'nonce',
            resultId: 'result-1',
            failureCode: null,
          },
        });
      },
      selectedModel: model,
      launchIdentity: {
        nodeId,
        attemptId,
        targetRepo: job.targetRepo,
        targetBranch: job.targetBranch,
        workspacePath: fixtureTemp,
        piRuntimeParent: join(runtimeRoot, 'pi-runtime'),
        piSessionDir: join(runtimeRoot, 'pi-session'),
        piExecutablePath: '/opt/pi/pi',
        piExecutableVersion: '0.83.0',
        piExecutableDigest: 'd'.repeat(64),
        packagePath: '/opt/pkg',
        packageProfile: 'pool-proof-builder',
        packageDigest: 'b'.repeat(64),
        profileName: 'pool-proof-builder',
        profilePath: '/opt/profile',
        profileDigest: 'c'.repeat(64),
        selectedModel: model,
        toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
        resultDestinationId: attemptId,
      },
      adapterProvenance: {
        launcher: 'real',
        sandbox: 'real',
        verifier: 'real',
        persistence: 'real',
      },
      persistAttempt: async ({ attemptId: pid, nodeId: nid, selectedModel: sm, resultId }) => {
        await persistence.importWorkAndCreateAttempt(
          {
            work_id: 'pool-proof-stage-1',
            origin: 'direct_task',
            repo: job.targetRepo,
            branch: job.targetBranch,
            payload_hash: 'sha256:pool-proof-fixture',
            nodes: [
              {
                id: nid,
                intent: job.intent,
                change_spec: job.changeSpec,
                acceptance_criteria: job.acceptanceCriteria.map((c) => c.text),
                depends_on: [],
                criteria_origin_source: job.criteriaOriginSource,
                criteria_origin_source_id: job.criteriaOriginSourceId,
              },
            ],
          },
          nid,
          pid,
          1,
          resultId,
          { builder: sm, policyVersion: 1 },
        );
      },
      verify: async (resources, runtimeJob, piProcess) => {
        capturedVerifierWorkspace = resources.workspacePath;
        const gitPath = spawnSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).stdout.trim() || 'git';
        const verifier = createPoolProofVerifier({
          gitPath,
          fixtureTestRunner: async (_cwd, command) => {
            const result = spawnSync(command[0], command.slice(1), {
              cwd: fixtureTemp,
              encoding: 'utf8',
              env: { PATH: process.env.PATH },
            });
            return {
              command,
              exitCode: result.status ?? 1,
              stdout: result.stdout.slice(0, 4096),
              stderr: result.stderr.slice(0, 4096),
              timedOut: false,
            };
          },
          hasConflictingResult: persistence.hasConflictingResult,
        });
        return verifier.verify(
          resources,
          { ...runtimeJob, expectedParentCommit: baseCommit, isolationProbes: ['false'] },
          piProcess,
        );
      },
      persistResult: async (result) => {
        await persistence.recordResult({
          attemptId: result.attemptId,
          resultId: result.resultId,
          nodeId,
          selectedModel: model,
          status: result.status,
          commitSha: result.commitSha,
          failureCode: result.failureCode,
          checks: result.checks,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
        });
      },
    });

    const submitResult = await runtime.submit(job);
    await store.close();

    assert.equal(submitResult.ok, true);
    assert.equal(capturedLauncherWorkspace, fixtureTemp, 'launcher expectations must use the fixture workspace');
    assert.equal(capturedBrokerWorkspace, fixtureTemp, 'broker options must use the fixture workspace');
    assert.equal(capturedVerifierWorkspace, fixtureTemp, 'verifier must receive the fixture workspace');
    assert.equal(existsSync(fixtureTemp), false, 'cleanup must remove the fixture workspace');
  });

  it('produces a valid failed report when the verifier rejects a submitted attempt', async () => {
    const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-runtime-')));
    const fixturePath = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-fixture-')));
    const identity = makeIdentityDirs(runtimeRoot);
    const { manifest, baseCommit } = initializeFixtureRepository(fixturePath);

    const nodeId = 'single-worker-pool-proof';
    const attemptId = 'single-worker-pool-proof-attempt-1';
    const job: ProofJob = { ...buildStage1Job(manifest, baseCommit, nodeId, attemptId), workspacePath: fixturePath };
    const model = 'moonshot/kimi-k2.7-code' as ApprovedModelId;

    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const socketPath = join(runtimeRoot, 'broker.sock');
    const piPath = makeFakePiScript(runtimeRoot);
    const piDigest = digestFile(piPath);

    const launchIdentity: PoolProofLaunchExpectations = {
      nodeId,
      attemptId,
      targetRepo: job.targetRepo,
      targetBranch: job.targetBranch,
      workspacePath: fixturePath,
      piRuntimeParent: join(runtimeRoot, 'pi-runtime'),
      piSessionDir: join(runtimeRoot, 'pi-session'),
      piExecutablePath: piPath,
      piExecutableVersion: '0.83.0',
      piExecutableDigest: piDigest,
      packagePath: identity.packagePath,
      packageProfile: 'pool-proof-builder',
      packageDigest: identity.packageDigest,
      profileName: 'pool-proof-builder',
      profilePath: identity.profilePath,
      profileDigest: identity.profileDigest,
      selectedModel: model,
      toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      resultDestinationId: attemptId,
    };

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (runtimeExpectations, runtimeJob) =>
        createPoolProofPiLauncher({
          expectations: runtimeExpectations,
          job: runtimeJob,
          brokerOptions: {
            socketPath,
            workspacePath: fixturePath,
            containerRuntime: 'docker',
            image: 'sha256:' + 'f'.repeat(64),
            cpuLimit: '1',
            memoryLimit: '1g',
            pidsLimit: 64,
          },
          verifyPackageAndProfile: identity.verify,
        }),
      selectedModel: model,
      launchIdentity,
      adapterProvenance: {
        launcher: 'real',
        sandbox: 'real',
        verifier: 'real',
        persistence: 'real',
      },
      persistAttempt: async ({ attemptId: pid, nodeId: nid, selectedModel: sm, resultId }) => {
        await persistence.importWorkAndCreateAttempt(
          {
            work_id: 'pool-proof-stage-1',
            origin: 'direct_task',
            repo: job.targetRepo,
            branch: job.targetBranch,
            payload_hash: 'sha256:pool-proof-fixture',
            nodes: [
              {
                id: nid,
                intent: job.intent,
                change_spec: job.changeSpec,
                acceptance_criteria: job.acceptanceCriteria.map((c) => c.text),
                depends_on: [],
                criteria_origin_source: job.criteriaOriginSource,
                criteria_origin_source_id: job.criteriaOriginSourceId,
              },
            ],
          },
          nid,
          pid,
          1,
          resultId,
          { builder: sm, policyVersion: 1 },
        );
      },
      verify: async (_resources, _runtimeJob, piProcess) => {
        return {
          status: 'failed' as const,
          commitSha: null,
          failureCode: 'VERIFIER_CHECK_FAILED',
          checks: [
            { name: 'process_exit_success', passed: true },
            { name: 'fixture_test_passes', passed: false },
          ],
          greenEvidence: null,
        };
      },
      persistResult: async (result) => {
        await persistence.recordResult({
          attemptId: result.attemptId,
          resultId: result.resultId,
          nodeId,
          selectedModel: model,
          status: result.status,
          commitSha: result.commitSha,
          failureCode: result.failureCode,
          checks: result.checks,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
        });
      },
    });

    const submitResult = await runtime.submit(job);

    assert.equal(submitResult.ok, true);
    assert.equal(submitResult.status, 'failed');

    const persisted = await persistence.getResult(attemptId);
    assert.ok(persisted);
    assert.equal(persisted!.failure_code, 'VERIFIER_CHECK_FAILED');
    await store.close();
  });

  it('cleans up runtime, fixture, auth, session, and broker residue on runtime exception', async () => {
    const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-runtime-')));
    const fixturePath = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-fixture-')));
    const identity = makeIdentityDirs(runtimeRoot);
    const { manifest, baseCommit } = initializeFixtureRepository(fixturePath);

    const nodeId = 'single-worker-pool-proof';
    const attemptId = 'single-worker-pool-proof-attempt-1';
    const job: ProofJob = { ...buildStage1Job(manifest, baseCommit, nodeId, attemptId), workspacePath: fixturePath };
    const model = 'moonshot/kimi-k2.7-code' as ApprovedModelId;

    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const socketPath = join(runtimeRoot, 'broker.sock');
    const piPath = makeFakePiScript(runtimeRoot);
    const piDigest = digestFile(piPath);

    const launchIdentity: PoolProofLaunchExpectations = {
      nodeId,
      attemptId,
      targetRepo: job.targetRepo,
      targetBranch: job.targetBranch,
      workspacePath: fixturePath,
      piRuntimeParent: join(runtimeRoot, 'pi-runtime'),
      piSessionDir: join(runtimeRoot, 'pi-session'),
      piExecutablePath: piPath,
      piExecutableVersion: '0.83.0',
      piExecutableDigest: piDigest,
      packagePath: identity.packagePath,
      packageProfile: 'pool-proof-builder',
      packageDigest: identity.packageDigest,
      profileName: 'pool-proof-builder',
      profilePath: identity.profilePath,
      profileDigest: identity.profileDigest,
      selectedModel: model,
      toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      resultDestinationId: attemptId,
    };

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: () => {
        throw new Error('simulated launcher explosion');
      },
      selectedModel: model,
      launchIdentity,
      adapterProvenance: {
        launcher: 'real',
        sandbox: 'real',
        verifier: 'real',
        persistence: 'real',
      },
      persistAttempt: async ({ attemptId: pid, nodeId: nid, selectedModel: sm, resultId }) => {
        await persistence.importWorkAndCreateAttempt(
          {
            work_id: 'pool-proof-stage-1',
            origin: 'direct_task',
            repo: job.targetRepo,
            branch: job.targetBranch,
            payload_hash: 'sha256:pool-proof-fixture',
            nodes: [
              {
                id: nid,
                intent: job.intent,
                change_spec: job.changeSpec,
                acceptance_criteria: job.acceptanceCriteria.map((c) => c.text),
                depends_on: [],
                criteria_origin_source: job.criteriaOriginSource,
                criteria_origin_source_id: job.criteriaOriginSourceId,
              },
            ],
          },
          nid,
          pid,
          1,
          resultId,
          { builder: sm, policyVersion: 1 },
        );
      },
      verify: async () => {
        throw new Error('should not reach verifier');
      },
      persistResult: async (result) => {
        await persistence.recordResult({
          attemptId: result.attemptId,
          resultId: result.resultId,
          nodeId,
          selectedModel: model,
          status: result.status,
          commitSha: result.commitSha,
          failureCode: result.failureCode,
          checks: result.checks,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
        });
      },
    });

    const submitResult = await runtime.submit(job);

    assert.equal(submitResult.ok, false);
    assert.equal(submitResult.error, 'RUNTIME_EXCEPTION', 'failure code must be the stable bounded code');
    assert.equal(submitResult.errorDetail?.includes('simulated launcher explosion'), true, 'error detail may carry diagnostic prose');
    assert.equal(String(submitResult.error).includes('simulated launcher explosion'), false, 'failure code must not leak exception prose');
    assert.equal(existsSync(fixturePath), false, 'fixture workspace must be removed');
    assert.equal(existsSync(join(runtimeRoot, 'pi-runtime')), false, 'pi runtime residue must be removed');
    assert.equal(existsSync(join(runtimeRoot, 'broker.sock')), false, 'broker socket residue must be removed');
    assert.equal(existsSync(join(runtimeRoot, 'auth.json')), false, 'provider auth residue must be removed');

    await store.close();
    await cleanupAttemptResources(store, runtimeRoot, fixturePath);

    assert.equal(existsSync(runtimeRoot), false, 'harness cleanup must remove the runtime root');
  });

  it('captures green evidence through persistResult with real adapters and controlled ports', async () => {
    const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-runtime-')));
    const fixturePath = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-fixture-')));
    const identity = makeIdentityDirs(runtimeRoot);
    const { manifest, baseCommit } = initializeFixtureRepository(fixturePath);

    // Create an attempt commit that makes the fixture test pass.
    writeFileSync(join(fixturePath, 'src', 'message.js'), "export function getMessage() { return 'world'; }");
    spawnSync('git', ['add', 'src/message.js'], { cwd: fixturePath, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'green', '--date', '2026-08-05T00:01:00Z'], {
      cwd: fixturePath,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_AUTHOR_NAME: 'Pool Proof',
        GIT_AUTHOR_EMAIL: 'proof@agent-pool.local',
        GIT_COMMITTER_NAME: 'Pool Proof',
        GIT_COMMITTER_EMAIL: 'proof@agent-pool.local',
      },
    });

    const nodeId = 'single-worker-pool-proof';
    const attemptId = 'single-worker-pool-proof-attempt-1';
    const job: ProofJob = { ...buildStage1Job(manifest, baseCommit, nodeId, attemptId), workspacePath: fixturePath };
    const model = 'openai-codex/gpt-5.6-terra' as ApprovedModelId;

    const store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const socketPath = join(runtimeRoot, 'broker.sock');
    const piPath = makeFakePiScript(runtimeRoot);
    const piDigest = digestFile(piPath);

    const launchIdentity: PoolProofLaunchExpectations = {
      nodeId,
      attemptId,
      targetRepo: job.targetRepo,
      targetBranch: job.targetBranch,
      workspacePath: fixturePath,
      piRuntimeParent: join(runtimeRoot, 'pi-runtime'),
      piSessionDir: join(runtimeRoot, 'pi-session'),
      piExecutablePath: piPath,
      piExecutableVersion: '0.83.0',
      piExecutableDigest: piDigest,
      packagePath: identity.packagePath,
      packageProfile: 'pool-proof-builder',
      packageDigest: identity.packageDigest,
      profileName: 'pool-proof-builder',
      profilePath: identity.profilePath,
      profileDigest: identity.profileDigest,
      selectedModel: model,
      toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      resultDestinationId: attemptId,
    };

    let capturedGreenEvidence: GreenEvidence | null = null;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (runtimeExpectations, runtimeJob) =>
        createPoolProofPiLauncher({
          expectations: runtimeExpectations,
          job: runtimeJob,
          brokerOptions: {
            socketPath,
            workspacePath: fixturePath,
            containerRuntime: 'docker',
            image: 'sha256:' + 'f'.repeat(64),
            cpuLimit: '1',
            memoryLimit: '1g',
            pidsLimit: 64,
          },
          verifyPackageAndProfile: identity.verify,
        }),
      selectedModel: model,
      launchIdentity,
      adapterProvenance: {
        launcher: 'real',
        sandbox: 'real',
        verifier: 'real',
        persistence: 'real',
      },
      persistAttempt: async ({ attemptId: pid, nodeId: nid, selectedModel: sm, resultId }) => {
        await persistence.importWorkAndCreateAttempt(
          {
            work_id: 'pool-proof-stage-1',
            origin: 'direct_task',
            repo: job.targetRepo,
            branch: job.targetBranch,
            payload_hash: 'sha256:pool-proof-fixture',
            nodes: [
              {
                id: nid,
                intent: job.intent,
                change_spec: job.changeSpec,
                acceptance_criteria: job.acceptanceCriteria.map((c) => c.text),
                depends_on: [],
                criteria_origin_source: job.criteriaOriginSource,
                criteria_origin_source_id: job.criteriaOriginSourceId,
              },
            ],
          },
          nid,
          pid,
          1,
          resultId,
          { builder: sm, policyVersion: 1 },
        );
      },
      verify: async (resources, runtimeJob, piProcess) => {
        const gitPath = spawnSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).stdout.trim() || 'git';
        const verifier = createPoolProofVerifier({
          gitPath,
          fixtureTestRunner: async (_cwd, command) => {
            const result = spawnSync(command[0], command.slice(1), {
              cwd: fixturePath,
              encoding: 'utf8',
              env: { PATH: process.env.PATH },
            });
            return {
              command,
              exitCode: result.status ?? 1,
              stdout: result.stdout.slice(0, 4096),
              stderr: result.stderr.slice(0, 4096),
              timedOut: false,
            };
          },
          hasConflictingResult: persistence.hasConflictingResult,
        });
        return verifier.verify(
          resources,
          { ...runtimeJob, expectedParentCommit: baseCommit, isolationProbes: ['false'] },
          piProcess,
        );
      },
      persistResult: async (result) => {
        capturedGreenEvidence = result.greenEvidence ?? null;
        await persistence.recordResult({
          attemptId: result.attemptId,
          resultId: result.resultId,
          nodeId,
          selectedModel: model,
          status: result.status,
          commitSha: result.commitSha,
          failureCode: result.failureCode,
          checks: result.checks,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
        });
      },
    });

    const submitResult = await runtime.submit(job);
    await store.close();

    assert.equal(submitResult.ok, true);
    assert.ok(capturedGreenEvidence, 'green evidence must be captured by persistResult');
    const evidence = capturedGreenEvidence as GreenEvidence;
    assert.equal(evidence.exitCode, 0, 'green evidence must have exit code 0');
    assert.equal(evidence.timedOut, false);
  });
});
