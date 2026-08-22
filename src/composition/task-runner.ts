/**
 * Production-composable generalized runner.
 *
 * Uses the injected OrchestrationStore and intake-derived identities. It does
 * not create or close the store.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createAttemptResourceFactory,
  createMinimalPoolRuntime,
  createMinimalPoolRuntimeForTest,
  createPoolProofPiLauncher,
  resolveShortSocketRoot,
  type AttemptResources,
  type PiLauncher,
  type PiProcess,
  type PoolProofLaunchExpectations,
  type ProofJob,
} from '../domains/agent-execution/index.ts';
import type { AdapterProvenance } from '../domains/agent-execution/minimal-pool-runtime.ts';
import { prepareWorkspaceForSandbox, resolveSandboxIdentity } from '../domains/agent-execution/sandbox-identity.ts';
import { createPoolProofVerifier, type GreenEvidence } from '../domains/verification/pool-proof-verifier.ts';
import {
  createPoolProofPersistence,
  deriveCriterionId,
  type OrchestrationStore,
} from '../domains/orchestration/index.ts';

import { hardenedGit } from './hardened-git.ts';
import type { TaskManifest } from './task-manifest.ts';

const SANDBOX_CPU = '1';
const SANDBOX_MEMORY = '1g';
const SANDBOX_PIDS = 64;
const SANDBOX_OUTPUT_CAP_BYTES = 4096;

export type TaskRunSandboxCommand = (
  workspacePath: string,
  command: readonly string[],
  timeoutSeconds: number,
) => Promise<GreenEvidence>;

export type TaskRunnerOverrides = {
  readonly createPiLauncher?: (expectations: PoolProofLaunchExpectations, job: ProofJob) => PiLauncher;
  readonly runSandboxCommand?: TaskRunSandboxCommand;
};

export type TaskRunnerIdentities = {
  readonly workId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly jobId: string;
  readonly criteriaOriginSourceId: string;
};

export type TaskRunnerPreflight = {
  readonly pi: { readonly path: string; readonly version: string; readonly digest: string };
  readonly package: { readonly path: string; readonly profile: string; readonly digest: string };
  readonly profile: { readonly name: string; readonly path: string; readonly digest: string };
  readonly gitPath: string;
};

export type RunClaimedTaskOptions = {
  readonly store: OrchestrationStore;
  readonly manifest: TaskManifest;
  readonly identities: TaskRunnerIdentities;
  readonly preflight: TaskRunnerPreflight;
  readonly containerRuntime: 'docker' | 'podman';
  readonly sandboxImage: string;
  readonly adapterProvenance: AdapterProvenance;
  readonly adapterOverrides?: TaskRunnerOverrides;
  readonly runtimeRoot: string;
};

export type ClaimedTaskRunResult = {
  readonly ok: boolean;
  readonly status: 'passed' | 'failed';
  readonly resultId: string;
  readonly commitSha: string | null;
  readonly failureCode: string | null;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
};

function appendSandboxOutput(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = SANDBOX_OUTPUT_CAP_BYTES - Buffer.byteLength(current, 'utf8');
  if (remaining <= 0) return { value: current, truncated: bytes.length > 0 };
  if (bytes.length <= remaining) return { value: current + bytes.toString('utf8'), truncated: true };
  return { value: current + bytes.subarray(0, remaining).toString('utf8'), truncated: false };
}

export function parseContainerRuntime(value: string): 'docker' | 'podman' {
  if (value !== 'docker' && value !== 'podman') {
    throw new Error(`CONTAINER_RUNTIME_INVALID: must be 'docker' or 'podman', got ${JSON.stringify(value)}`);
  }
  return value;
}

export function resolveContainerRuntime(containerRuntime: 'docker' | 'podman'): string {
  let resolved: string;
  try {
    resolved = execFileSync('command', ['-v', containerRuntime], { encoding: 'utf8', shell: false }).trim();
  } catch {
    throw new Error(`CONTAINER_RUNTIME_NOT_FOUND: ${containerRuntime} executable not found in PATH`);
  }
  if (resolved.length === 0) {
    throw new Error(`CONTAINER_RUNTIME_NOT_FOUND: ${containerRuntime} executable not found in PATH`);
  }
  let rawStat: ReturnType<typeof lstatSync>;
  try {
    rawStat = lstatSync(resolved);
  } catch (e) {
    throw new Error(`CONTAINER_RUNTIME_MISSING: ${resolved} could not be inspected: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (rawStat.isSymbolicLink()) {
    throw new Error(`CONTAINER_RUNTIME_IS_SYMLINK: ${resolved} is a symbolic link`);
  }
  const canonical = realpathSync(resolved);
  const st = lstatSync(canonical);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error(`CONTAINER_RUNTIME_NOT_FILE: ${canonical} is not a regular file`);
  }
  return canonical;
}

async function runRealSandboxCommand(
  containerRuntime: 'docker' | 'podman',
  sandboxImage: string,
  workspacePath: string,
  command: readonly string[],
  timeoutSeconds: number,
): Promise<GreenEvidence> {
  const runtimePath = resolveContainerRuntime(containerRuntime);
  const sandboxIdentity = resolveSandboxIdentity();
  return new Promise((resolvePromise, reject) => {
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let killed = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
      sigkillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10_000);
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (d: Buffer) => {
      const next = appendSandboxOutput(stdout, d);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on('data', (d: Buffer) => {
      const next = appendSandboxOutput(stderr, d);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(killTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolvePromise({
        command,
        exitCode: killed ? 124 : (exitCode ?? 1),
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export function prepareTaskWorkspace(
  gitPath: string,
  sourceRepoPath: string,
  workspacePath: string,
  baseCommit: string,
): void {
  mkdirSync(dirname(workspacePath), { recursive: true });
  const clone = hardenedGit(gitPath, dirname(workspacePath), ['clone', '--no-checkout', sourceRepoPath, workspacePath]);
  if (!clone.ok) throw new Error(`TASK_CLONE_FAILED: ${clone.error}`);
  const checkout = hardenedGit(gitPath, workspacePath, ['checkout', '-q', '--detach', baseCommit]);
  if (!checkout.ok) throw new Error(`TASK_CHECKOUT_FAILED: ${checkout.error}`);
  const head = hardenedGit(gitPath, workspacePath, ['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout !== baseCommit) {
    throw new Error('BASE_COMMIT_MISMATCH: rev-parse HEAD did not equal the pinned base commit after checkout');
  }
  const status = hardenedGit(gitPath, workspacePath, ['status', '--porcelain']);
  if (!status.ok || status.stdout !== '') {
    throw new Error('BASE_TREE_DIRTY: the pinned base commit tree is not clean');
  }
}

export async function runClaimedTask(options: RunClaimedTaskOptions): Promise<ClaimedTaskRunResult> {
  const hasFake = Object.values(options.adapterProvenance).some((v) => v === 'fake');
  const hasOverrides = options.adapterOverrides !== undefined;
  if (hasOverrides && !hasFake) {
    throw new Error('POOL_PROOF_REAL_ADAPTER_OVERRIDE_REJECTED');
  }
  if (hasFake && !hasOverrides) {
    throw new Error('POOL_PROOF_FAKE_ADAPTER_REJECTED');
  }

  const { manifest, identities, preflight } = options;
  const timeoutSeconds = manifest.bounds.verification_timeout_seconds;
  const sandboxIdentity = resolveSandboxIdentity();
  const sandboxRunner: (workspacePath: string, command: readonly string[]) => Promise<GreenEvidence> =
    options.adapterOverrides?.runSandboxCommand !== undefined
      ? (workspacePath, command) => options.adapterOverrides!.runSandboxCommand!(workspacePath, command, timeoutSeconds)
      : (workspacePath, command) => runRealSandboxCommand(options.containerRuntime, options.sandboxImage, workspacePath, command, timeoutSeconds);

  const workspaceTemp = realpathSync(mkdtempSync(join(tmpdir(), 'direct-task-workspace-')));
  const workspacePath = join(workspaceTemp, 'task-workspace');
  const persistence = createPoolProofPersistence(options.store);
  const startedAt = new Date();
  try {
    prepareTaskWorkspace(preflight.gitPath, manifest.target_repo_path, workspacePath, manifest.base_commit);
    prepareWorkspaceForSandbox(workspacePath, sandboxIdentity);

    const brokerSocketRoot = resolveShortSocketRoot();
    const resourceFactory = createAttemptResourceFactory({ runtimeRoot: options.runtimeRoot, socketRoot: brokerSocketRoot });
    const attemptResources = new Map<string, AttemptResources>();
    const job: ProofJob = {
      nodeId: identities.nodeId,
      attemptId: identities.attemptId,
      attemptNumber: identities.attemptNumber,
      intent: manifest.intent,
      changeSpec: manifest.change_spec,
      acceptanceCriteria: manifest.acceptance_criteria.map((c, index) => ({
        id: c.id || deriveCriterionId(identities.workId, identities.nodeId, index, c.text),
        text: c.text,
      })),
      criteriaOriginSource: 'direct_task',
      criteriaOriginSourceId: identities.criteriaOriginSourceId,
      targetRepo: manifest.task_id,
      targetBranch: 'detached',
      allowedChangedPaths: [...manifest.allowed_changed_paths],
      fixtureTestCommand: [...manifest.verification_commands[0]!],
      workspacePath,
    };
    const launchIdentity: PoolProofLaunchExpectations = {
      nodeId: job.nodeId,
      attemptId: job.attemptId,
      targetRepo: job.targetRepo,
      targetBranch: job.targetBranch,
      workspacePath,
      piRuntimeParent: join(options.runtimeRoot, 'pi-runtime'),
      piSessionDir: join(options.runtimeRoot, 'pi-session'),
      piExecutablePath: preflight.pi.path,
      piExecutableVersion: preflight.pi.version,
      piExecutableDigest: preflight.pi.digest,
      packagePath: preflight.package.path,
      packageProfile: preflight.package.profile,
      packageDigest: preflight.package.digest,
      profileName: preflight.profile.name,
      profilePath: preflight.profile.path,
      profileDigest: preflight.profile.digest,
      selectedModel: manifest.model,
      toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      resultDestinationId: identities.attemptId,
    };

    let resultId = identities.attemptId;
    const createRuntime = hasFake ? createMinimalPoolRuntimeForTest : createMinimalPoolRuntime;
    const runtime = createRuntime({
      resourceFactory: {
        allocate: (id: string, allocatedWorkspace?: string) => {
          const resources = resourceFactory.allocate(id, allocatedWorkspace);
          attemptResources.set(id, resources);
          return resources;
        },
        release: (resources: AttemptResources) => resourceFactory.release(resources),
      },
      createPiLauncher: (expectations, runtimeJob) => {
        if (options.adapterOverrides?.createPiLauncher) {
          return options.adapterOverrides.createPiLauncher(expectations, runtimeJob);
        }
        const resources = attemptResources.get(runtimeJob.attemptId);
        const socketPath = resources?.brokerSocketPath;
        if (!socketPath) {
          throw new Error('BROKER_SOCKET_NOT_ALLOCATED: task runner requires a short broker socket path');
        }
        return createPoolProofPiLauncher({
          expectations,
          job: runtimeJob,
          brokerOptions: {
            socketPath,
            workspacePath: expectations.workspacePath,
            containerRuntime: options.containerRuntime,
            image: options.sandboxImage,
            cpuLimit: SANDBOX_CPU,
            memoryLimit: SANDBOX_MEMORY,
            pidsLimit: SANDBOX_PIDS,
            sandboxIdentity,
          },
          verifyPackageAndProfile: async () => true,
        });
      },
      selectedModel: manifest.model,
      launchIdentity,
      adapterProvenance: options.adapterProvenance,
      slotCount: 1,
      persistAttempt: async ({ resultId: rid }) => {
        resultId = rid;
      },
      verify: async (resources: AttemptResources, runtimeJob: ProofJob, process: PiProcess) => {
        const verifier = createPoolProofVerifier({
          gitPath: preflight.gitPath,
          fixtureTestRunner: (cwd, command) => sandboxRunner(cwd, command),
          hasConflictingResult: persistence.hasConflictingResult,
        });
        const verdict = await verifier.verify(
          resources,
          {
            ...runtimeJob,
            fixtureTestCommand: manifest.verification_commands[0]!,
            expectedParentCommit: manifest.base_commit,
          },
          process,
        );
        const mergedChecks = [...verdict.checks];
        let remainingFailed = false;
        for (let index = 1; index < manifest.verification_commands.length; index += 1) {
          const command = manifest.verification_commands[index]!;
          const evidence = await sandboxRunner(resources.workspacePath, command);
          const passed = evidence.exitCode === 0 && !evidence.timedOut;
          mergedChecks.push({ name: `verification_command_${index + 1}`, passed });
          if (!passed) remainingFailed = true;
        }
        const allPassed = mergedChecks.every((c) => c.passed);
        return {
          status: allPassed ? 'passed' as const : 'failed' as const,
          commitSha: allPassed ? verdict.commitSha : null,
          failureCode: allPassed
            ? null
            : (verdict.failureCode ?? (remainingFailed ? 'VERIFICATION_COMMAND_FAILED' : 'VERIFIER_CHECK_FAILED')),
          checks: mergedChecks,
          greenEvidence: allPassed ? verdict.greenEvidence : null,
        };
      },
      persistResult: async (result) => {
        await persistence.recordResult({
          attemptId: result.attemptId,
          resultId: result.resultId,
          nodeId: job.nodeId,
          selectedModel: manifest.model,
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
    await runtime.shutdown();
    const finishedAt = new Date();
    const persisted = await persistence.getResult(identities.attemptId);
    const checks = (await persistence.getChecks(identities.attemptId)).map((c) => ({
      name: c.check_name,
      passed: c.passed === 1,
    }));
    const passed = submitResult.ok && submitResult.status === 'passed';
    return {
      ok: passed,
      status: passed ? 'passed' : 'failed',
      resultId: submitResult.ok ? submitResult.resultId : resultId,
      commitSha: persisted?.commit_sha ?? null,
      failureCode: passed ? null : (persisted?.failure_code ?? (!submitResult.ok ? submitResult.error : 'TASK_VERIFIER_CHECK_FAILED')),
      checks: checks.length > 0 ? checks : [{ name: 'runtime_submit', passed: false }],
      startedAt,
      finishedAt,
    };
  } finally {
    if (existsSync(workspaceTemp)) {
      try { rmSync(workspaceTemp, { recursive: true, force: true }); } catch {}
    }
  }
}
