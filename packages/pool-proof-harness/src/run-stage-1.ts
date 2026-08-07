/**
 * Stage 1 real proof entry point.
 *
 * Initializes the deterministic fixture, submits the job through the public
 * Minimal Pool Runtime, verifies independently, cleans up, and writes a schema-
 * valid proof report. Rejects fake adapters.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMinimalPoolRuntime,
  createPoolProofPiLauncher,
  createAttemptResourceFactory,
  type ProofJob,
  type AttemptResources,
  type PiProcess,
  type PoolProofLaunchExpectations,
  type PackageProfileVerifier,
} from '../../../src/domains/agent-execution/index.ts';
import { createPoolProofVerifier } from '../../../src/domains/verification/pool-proof-verifier.ts';
import { createSqliteStore, createPoolProofPersistence, type ProofCheckRecord, type OrchestrationStore } from '../../../src/domains/orchestration/index.ts';
import type { ApprovedModelId } from '../../../src/domains/model-routing-and-evaluation/approved-models.ts';
import { prepareWorkspaceForSandbox, resolveSandboxIdentity } from '../../../src/domains/agent-execution/sandbox-identity.ts';

import { initializeFixtureRepository, loadFixtureManifest } from './fixture-repository.ts';
import { buildStage1Job } from './stage-1-job.ts';
import { buildReport, validateReport, type Stage1ProofReport } from './report.ts';
import { runPreflight } from './preflight.ts';
import { resolvePackageIdentity, resolveProfileIdentity } from './identity-resolution.ts';
import type { GreenEvidence } from '../../../src/domains/verification/pool-proof-verifier.ts';

const FAILURE_CODE_MAX_LEN = 256;

function sanitizeFailureCode(input: string): string {
  const cleaned = input
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
  if (cleaned.length === 0) return 'UNKNOWN_FAILURE';
  return cleaned.slice(0, FAILURE_CODE_MAX_LEN);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = resolve(packageRoot, 'reports');
const reportPath = resolve(reportsDir, 'stage-1-proof-report.json');
const failureReportPath = resolve(reportsDir, 'stage-1-preflight-failure.json');

const SANDBOX_CPU = '1';
const SANDBOX_MEMORY = '1g';
const SANDBOX_PIDS = 64;

function resolveContainerRuntime(containerRuntime: 'docker' | 'podman'): string {
  try {
    return execFileSync('command', ['-v', containerRuntime], { encoding: 'utf8', shell: true }).trim();
  } catch {
    throw new Error(`container runtime executable not found: ${containerRuntime}`);
  }
}

async function runSandboxCommand(
  containerRuntime: 'docker' | 'podman',
  sandboxImage: string,
  workspacePath: string,
  command: readonly string[],
  sandboxIdentity = resolveSandboxIdentity(),
): Promise<GreenEvidence> {
  const { spawn } = await import('node:child_process');
  const runtimePath = resolveContainerRuntime(containerRuntime);
  return new Promise((resolve, reject) => {
    const child = spawn(runtimePath, [
      'run', '--rm', '-i', '--network=none', '--privileged=false',
      '--security-opt=no-new-privileges', '--cap-drop=ALL', '--read-only',
      '--user', `${sandboxIdentity.uid}:${sandboxIdentity.gid}`,
      '--cpus', SANDBOX_CPU,
      '--memory', SANDBOX_MEMORY,
      '--pids-limit', String(SANDBOX_PIDS),
      '--tmpfs', '/tmp:noexec,nosuid,size=100m',
      '-v', `${workspacePath}:/workspace:rw`, '-w', '/workspace',
      '-e', 'HOME=/workspace/.home',
      '--entrypoint=', sandboxImage, ...command,
    ], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      sigkillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 10_000);
    }, 120_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(killTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({
        command,
        exitCode: killed ? 124 : (exitCode ?? 1),
        stdout: stdout.slice(0, 4096),
        stderr: stderr.slice(0, 4096),
        timedOut,
      });
    });
  });
}

export function isValidBaseRed(evidence: GreenEvidence): boolean {
  return evidence.exitCode !== 0 && !evidence.timedOut;
}

export async function cleanupAttemptResources(
  store: OrchestrationStore | undefined,
  runtimeRoot: string | undefined,
  fixtureTemp: string | undefined,
): Promise<void> {
  if (store) {
    try {
      await store.close();
    } catch {
      // bounded cleanup failure
    }
  }
  if (runtimeRoot) {
    try {
      rmSync(runtimeRoot, { recursive: true, force: true });
    } catch {
      // bounded cleanup failure
    }
  }
  if (fixtureTemp) {
    try {
      rmSync(fixtureTemp, { recursive: true, force: true });
    } catch {
      // bounded cleanup failure
    }
  }
}

export function writeValidatedReport(report: Stage1ProofReport, path: string): void {
  const validated = validateReport(report);
  if (!validated.ok) {
    throw new Error(`report validation failed: ${validated.error}`);
  }
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const piFlag = args.indexOf('--pi');
  const modelFlag = args.indexOf('--model');
  const runtimeFlag = args.indexOf('--container-runtime');
  const imageFlag = args.indexOf('--sandbox-image');
  const piPath = piFlag >= 0 ? args[piFlag + 1] : undefined;
  const model = (modelFlag >= 0 ? args[modelFlag + 1] : 'openai-codex/gpt-5.6-terra') as ApprovedModelId;
  const containerRuntime = (runtimeFlag >= 0 ? args[runtimeFlag + 1] : 'docker') as 'docker' | 'podman';
  const sandboxImage = imageFlag >= 0 ? args[imageFlag + 1] : undefined;

  if (!sandboxImage) {
    console.error('sandbox image digest/ID is required');
    process.exit(1);
  }

  // Delete any stale report before attempting this run.
  try {
    rmSync(reportPath, { force: true });
  } catch {
    // ignore
  }

  const preflight = await runPreflight({ piPath, model, containerRuntime, sandboxImage });
  if (!preflight.ok) {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(failureReportPath, JSON.stringify(preflight.failure, null, 2));
    console.error(`preflight failed: ${preflight.failure.stage} - ${preflight.failure.reason}`);
    process.exit(1);
  }

  const { pi: piIdentity, package: packageIdentity, profile: profileIdentity, gitPath } = preflight.result;

  let store: OrchestrationStore | undefined;
  let runtimeRoot: string | undefined;
  let fixtureTemp: string | undefined;
  let cleaned = false;

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    await cleanupAttemptResources(store, runtimeRoot, fixtureTemp);
    store = undefined;
    runtimeRoot = undefined;
    fixtureTemp = undefined;
  }

  try {
    runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-runtime-')));
    store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    fixtureTemp = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-fixture-')));
    const sandboxIdentity = resolveSandboxIdentity();
    const { manifest, baseCommit } = initializeFixtureRepository(fixtureTemp);
    prepareWorkspaceForSandbox(fixtureTemp, sandboxIdentity);
    const nodeId = 'single-worker-pool-proof';
    const attemptId = 'single-worker-pool-proof-attempt-1';
    const job = buildStage1Job(manifest, baseCommit, nodeId, attemptId, fixtureTemp);

    // Base red: run the fixture command in the real sandbox before Pi launch.
    const redEvidence = await runSandboxCommand(containerRuntime, sandboxImage, fixtureTemp!, job.fixtureTestCommand, sandboxIdentity);
    if (!isValidBaseRed(redEvidence)) {
      const failureCode = redEvidence.timedOut ? 'BASE_RED_TIMEOUT' : 'BASE_RED_INVALID';
      const report = buildReport({
        nodeId,
        attemptId,
        model,
        baseCommit,
        resultCommit: null,
        status: 'failed',
        fakeAdapter: false,
        checks: [{ name: 'base_red_nonzero', passed: false }],
        startedAt: new Date(),
        finishedAt: new Date(),
        failureCode,
        cleanupDisposition: { workspaceRemoved: false, sessionRemoved: false },
        redEvidence: {
          command: redEvidence.command,
          exitCode: redEvidence.exitCode,
          outputArtifact: (redEvidence.stdout + redEvidence.stderr).slice(0, 4096),
        },
        greenEvidence: {
          command: job.fixtureTestCommand,
          exitCode: 1,
          outputArtifact: 'base red was invalid; no green evidence produced',
        },
      });
      writeValidatedReport(report, reportPath);
      await cleanup();
      console.error(`base red invalid: ${failureCode}`);
      process.exit(1);
    }

    const launchIdentity: PoolProofLaunchExpectations = {
      nodeId: job.nodeId,
      attemptId: job.attemptId,
      targetRepo: job.targetRepo,
      targetBranch: job.targetBranch,
      workspacePath: fixtureTemp!,
      piRuntimeParent: join(runtimeRoot, 'pi-runtime'),
      piSessionDir: join(runtimeRoot, 'pi-session'),
      piExecutablePath: piIdentity.path,
      piExecutableVersion: piIdentity.version,
      piExecutableDigest: piIdentity.digest,
      packagePath: packageIdentity.path,
      packageProfile: packageIdentity.profile,
      packageDigest: packageIdentity.digest,
      profileName: profileIdentity.name,
      profilePath: profileIdentity.path,
      profileDigest: profileIdentity.digest,
      selectedModel: model,
      toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      resultDestinationId: attemptId,
    };

    const socketPath = join(runtimeRoot, 'broker.sock');

    const verifyPackageAndProfile: PackageProfileVerifier = async (_packagePath, packageDigest, _profilePath, profileDigest) => {
      const currentPackage = resolvePackageIdentity();
      const currentProfile = resolveProfileIdentity();
      return currentPackage.digest === packageDigest && currentProfile.digest === profileDigest;
    };

    // Declared before submission so persistResult can capture green evidence
    // without a Temporal Dead Zone error on successful verification.
    let capturedGreenEvidence: GreenEvidence | null = null;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: createAttemptResourceFactory({ runtimeRoot }),
      createPiLauncher: (runtimeExpectations, runtimeJob) =>
        createPoolProofPiLauncher({
          expectations: runtimeExpectations,
          job: runtimeJob,
          brokerOptions: {
            socketPath,
            workspacePath: fixtureTemp!,
            containerRuntime,
            image: sandboxImage!,
            cpuLimit: SANDBOX_CPU,
            memoryLimit: SANDBOX_MEMORY,
            pidsLimit: SANDBOX_PIDS,
            sandboxIdentity,
          },
          verifyPackageAndProfile,
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
      verify: async (resources: AttemptResources, runtimeJob: ProofJob, process: PiProcess) => {
        const sandboxRunner = async (_cwd: string, command: readonly string[]) =>
          runSandboxCommand(containerRuntime, sandboxImage, resources.workspacePath, command);
        const verifier = createPoolProofVerifier({
          gitPath,
          fixtureTestRunner: sandboxRunner,
          hasConflictingResult: persistence.hasConflictingResult,
        });
        return verifier.verify(resources, { ...runtimeJob, expectedParentCommit: baseCommit }, process);
      },
      persistResult: async (result) => {
        capturedGreenEvidence = result.greenEvidence ?? null;
        await persistence.recordResult({
          attemptId: result.attemptId,
          resultId: result.resultId,
          nodeId: job.nodeId,
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

    const startedAt = new Date();
    const submitResult = await runtime.submit(job);
    const finishedAt = new Date();

    let resultCommit: string | null = null;
    let checks: { name: string; passed: boolean }[] = [];
    let greenEvidence: GreenEvidence = {
      command: job.fixtureTestCommand,
      exitCode: 1,
      stdout: '',
      stderr: 'no green evidence produced',
      timedOut: false,
    };

    let persistedResult: Awaited<ReturnType<typeof persistence.getResult>> | null = null;
    if (submitResult.ok) {
      persistedResult = await persistence.getResult(submitResult.attemptId);
      resultCommit = persistedResult?.commit_sha ?? null;
      checks = (await persistence.getChecks(submitResult.attemptId)).map((c: ProofCheckRecord) => ({ name: c.check_name, passed: c.passed === 1 }));
    } else {
      checks = [{ name: 'runtime_submit', passed: false }];
    }

    // Capture actual cleanup disposition reported by the runtime before the
    // runtime root is deleted.
    const cleanupDisposition = submitResult.cleanupDisposition ?? { attemptRootRemoved: false, workspaceRemoved: false, errors: ['runtime did not report cleanup disposition'] };
    const sessionStillExists = existsSync(join(runtimeRoot, 'pi-session'));

    // If the verifier produced green evidence (passing result only), use it.
    if (submitResult.ok && submitResult.status === 'passed' && capturedGreenEvidence) {
      greenEvidence = capturedGreenEvidence;
    }

    const status = submitResult.ok && submitResult.status === 'passed' ? 'passed' : 'failed';
    const failureCode = (() => {
      if (submitResult.ok) {
        if (submitResult.status === 'failed') {
          return persistedResult?.failure_code ?? 'VERIFIER_CHECK_FAILED';
        }
        return null;
      }
      return submitResult.error;
    })();

    const report = buildReport({
      nodeId,
      attemptId,
      model,
      baseCommit,
      resultCommit,
      status,
      fakeAdapter: false,
      checks,
      startedAt,
      finishedAt,
      failureCode,
      cleanupDisposition: {
        workspaceRemoved: cleanupDisposition.workspaceRemoved,
        sessionRemoved: cleanupDisposition.attemptRootRemoved && !sessionStillExists,
      },
      redEvidence: {
        command: redEvidence.command,
        exitCode: redEvidence.exitCode,
        outputArtifact: (redEvidence.stdout + redEvidence.stderr).slice(0, 4096),
      },
      greenEvidence: {
        command: greenEvidence.command,
        exitCode: greenEvidence.exitCode,
        outputArtifact: (greenEvidence.stdout + greenEvidence.stderr).slice(0, 4096),
      },
    });

    await cleanup();
    writeValidatedReport(report, reportPath);

    if (report.status !== 'passed') {
      console.error(`Stage 1 proof failed: ${report.diagnostics.failure_code}`);
      process.exit(1);
    }
    console.log(`Stage 1 proof passed: ${reportPath}`);
  } catch (e) {
    const rawFailure = e instanceof Error ? e.message : String(e);
    const failureCode = sanitizeFailureCode(rawFailure);
    const report = buildReport({
      nodeId: 'single-worker-pool-proof',
      attemptId: 'single-worker-pool-proof-attempt-1',
      model,
      baseCommit: '0000000000000000000000000000000000000000',
      resultCommit: null,
      status: 'failed',
      fakeAdapter: false,
      checks: [{ name: 'runtime_exception', passed: false }],
      startedAt: new Date(),
      finishedAt: new Date(),
      failureCode,
      cleanupDisposition: { workspaceRemoved: false, sessionRemoved: false },
      redEvidence: {
        command: ['unknown'],
        exitCode: 1,
        outputArtifact: 'exception before base red',
      },
      greenEvidence: {
        command: ['unknown'],
        exitCode: 1,
        outputArtifact: 'no green evidence produced',
      },
    });
    try {
      writeValidatedReport(report, reportPath);
    } catch (validationErr) {
      console.error(`failed to write exception report: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`);
    }
    await cleanup();
    console.error(e);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
