/**
 * Generalized task runner: one approved task manifest through the proven
 * Minimal Pool Runtime composition (no fixture-specific branches).
 *
 * Flow: strict manifest validation (zero side effects on rejection) → adapter
 * entry-point rules → candidate-output guard (rejects anything resolving into
 * packages/pool-proof-harness/reports/ BEFORE any mkdir) → fresh temp clone
 * with detached checkout of the pinned 40-hex base commit through the
 * harness-owned hardened-git helper → informational base-state command
 * evidence → createMinimalPoolRuntime with the existing pool-proof Pi
 * launcher, verifier (expectedParentCommit=base_commit, first verification
 * command), and persistence → remaining verification commands evaluated by the
 * runner through the same sandbox command helper with merged checks → cleanup
 * → schema-validated runner-owned evidence at a candidate path only.
 *
 * The sandbox-command timeout is bound from manifest
 * bounds.verification_timeout_seconds (60..900); no hardcoded 120s path
 * exists. Every git invocation routes through src/hardened-git.ts.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMinimalPoolRuntime,
  createPoolProofPiLauncher,
  createAttemptResourceFactory,
  createRepositoryBoundTaskContent,
  resolveShortSocketRoot,
  type AttemptResources,
  type PiLauncher,
  type PiProcess,
  type PoolProofLaunchExpectations,
  type ProofJob,
  type RepositoryBoundPoolConfig,
  type RepositoryBoundTaskContent,
} from '../../../src/domains/agent-execution/index.ts';
import type { AdapterProvenance } from '../../../src/domains/agent-execution/minimal-pool-runtime.ts';
import { createPoolProofVerifier, type GreenEvidence } from '../../../src/domains/verification/pool-proof-verifier.ts';
import {
  createSqliteStore,
  createPoolProofPersistence,
  type ProofCheckRecord,
  type OrchestrationStore,
} from '../../../src/domains/orchestration/index.ts';
import { prepareWorkspaceForSandbox, resolveSandboxIdentity } from '../../../src/domains/agent-execution/sandbox-identity.ts';

import { hardenedGit } from './hardened-git.ts';
import { loadTaskManifest } from './task-manifest.ts';
import { buildTaskRunEvidence, validateTaskRunEvidence, type TaskRunEvidence } from './task-run-evidence.ts';
import { runPreflight, type PreflightSuccess } from './preflight.ts';
import { resolvePackageIdentity, resolveProfileIdentity } from './identity-resolution.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = resolve(packageRoot, 'reports');

const EVIDENCE_FILENAME = 'task-run-evidence.json';
const SANDBOX_CPU = '1';
const SANDBOX_MEMORY = '1g';
const SANDBOX_PIDS = 64;
/** Per-stream receipt cap; excess bytes are discarded before they accumulate. */
const SANDBOX_OUTPUT_CAP_BYTES = 4096;

export type TaskRunSandboxCommand = (
  workspacePath: string,
  command: readonly string[],
  timeoutSeconds: number,
) => Promise<GreenEvidence>;

export type RunTaskOptions = {
  /** Explicit reviewed manifest path (process-level review trust). */
  readonly manifestPath: string;
  readonly preflight: PreflightSuccess;
  readonly containerRuntime: 'docker' | 'podman';
  readonly sandboxImage: string;
  readonly adapterProvenance: AdapterProvenance;
  /** Candidate evidence output path; guarded against the retained reports tree. */
  readonly reportOutputPath?: string;
  /** Optional CLI cross-check: must equal manifest.model exactly. */
  readonly modelOverride?: string;
  /** Test-only observable seams proving ordering (zero calls on rejection). */
  readonly sideEffectObserver?: (effect: 'clone' | 'store' | 'resource' | 'adapter' | 'sandbox') => void;
  /** Test-only adapter overrides; allowed only with explicit fake provenance. */
  readonly adapterOverrides?: {
    readonly createPiLauncher?: (expectations: PoolProofLaunchExpectations, job: ProofJob) => PiLauncher;
    readonly runSandboxCommand?: TaskRunSandboxCommand;
  };
};

type InternalRunTaskOptions = RunTaskOptions & {
  /** Allocated by the configured entry only; never exposed by the manifest API. */
  readonly executionRoot?: string;
  /** Frozen configured-pool launch bound; legacy manifests leave this undefined. */
  readonly launchTimeoutSeconds?: number;
};

/** Host-owned construction inputs; task callers never receive this type. */
export type ConfiguredPoolHostOptions = {
  readonly preflight: PreflightSuccess;
  readonly containerRuntime: 'docker' | 'podman';
  readonly sandboxImage: string;
  /** Test-only adapter overrides, subject to the same provenance rule as runTask. */
  readonly adapterOverrides?: RunTaskOptions['adapterOverrides'];
};

/** Opaque one-slot pool. Its sole request method accepts validated content. */
export type ConfiguredRepositoryBoundPool = {
  readonly run: (task: RepositoryBoundTaskContent) => Promise<TaskRunResult>;
};

export type TaskRunResult =
  | { readonly ok: true; readonly report: TaskRunEvidence; readonly evidencePath: string }
  | {
    readonly ok: false;
    readonly reason: string;
    readonly failureCode: string;
    readonly report: TaskRunEvidence | null;
    readonly evidencePath: string | null;
  };

/**
 * Candidate-output guard. Resolves the requested path through not-yet-existing
 * ancestors and rejects anything equal to or inside the retained reports tree
 * BEFORE creating any directory; only then is the candidate directory made.
 */
export function resolveCandidateOutputPath(requested: string): string {
  if (typeof requested !== 'string' || requested.length === 0 || basename(requested) !== EVIDENCE_FILENAME) {
    throw new Error(`TASK_OUTPUT_FILENAME_INVALID: candidate output must end with ${EVIDENCE_FILENAME}`);
  }
  const path = resolve(requested);
  let probe = dirname(path);
  const missing: string[] = [];
  while (!existsSync(probe)) {
    missing.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realAncestor = realpathSync(probe);
  const candidate = missing.length > 0
    ? join(realAncestor, ...missing, EVIDENCE_FILENAME)
    : join(realAncestor, EVIDENCE_FILENAME);
  const retained = realpathSync(reportsDir);
  if (candidate === retained || candidate.startsWith(`${retained}${sep}`)) {
    throw new Error('TASK_OUTPUT_INSIDE_RETAINED_REPORTS: candidate output must not resolve inside packages/pool-proof-harness/reports/');
  }
  mkdirSync(dirname(candidate), { recursive: true });
  return candidate;
}

/**
 * Fresh isolated task workspace: clone the reviewed repository, detach at the
 * pinned base commit, and assert HEAD and a clean tree. Every git invocation
 * goes through the harness hardened-git helper (hostile .git/config safe).
 */
export function prepareTaskWorkspace(
  gitPath: string,
  sourceRepoPath: string,
  workspacePath: string,
  baseCommit: string,
): void {
  mkdirSync(dirname(workspacePath), { recursive: true });
  const clone = hardenedGit(gitPath, dirname(workspacePath), ['clone', '--no-hardlinks', '--no-checkout', sourceRepoPath, workspacePath]);
  if (!clone.ok) {
    throw new Error(`TASK_CLONE_FAILED: ${clone.error}`);
  }
  const checkout = hardenedGit(gitPath, workspacePath, ['checkout', '-q', '--detach', baseCommit]);
  if (!checkout.ok) {
    throw new Error(`TASK_CHECKOUT_FAILED: ${checkout.error}`);
  }
  const head = hardenedGit(gitPath, workspacePath, ['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout !== baseCommit) {
    throw new Error(`BASE_COMMIT_MISMATCH: rev-parse HEAD did not equal the pinned base commit after checkout`);
  }
  const status = hardenedGit(gitPath, workspacePath, ['status', '--porcelain']);
  if (!status.ok || status.stdout !== '') {
    throw new Error('BASE_TREE_DIRTY: the pinned base commit tree is not clean');
  }
}

function appendSandboxOutput(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = SANDBOX_OUTPUT_CAP_BYTES - Buffer.byteLength(current, 'utf8');
  if (remaining <= 0) return { value: current, truncated: bytes.length > 0 };
  if (bytes.length <= remaining) return { value: current + bytes.toString('utf8'), truncated: false };
  return { value: current + bytes.subarray(0, remaining).toString('utf8'), truncated: true };
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

  // Reject a symlink at the PATH-resolved location before canonicalization;
  // realpathSync would resolve it and hide the indirection.
  let rawStat: ReturnType<typeof lstatSync>;
  try {
    rawStat = lstatSync(resolved);
  } catch (e) {
    throw new Error(`CONTAINER_RUNTIME_MISSING: ${resolved} could not be inspected: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (rawStat.isSymbolicLink()) {
    throw new Error(`CONTAINER_RUNTIME_IS_SYMLINK: ${resolved} is a symbolic link`);
  }

  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch (e) {
    throw new Error(`CONTAINER_RUNTIME_MISSING: ${resolved} could not be resolved: ${e instanceof Error ? e.message : String(e)}`);
  }

  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(canonical);
  } catch (e) {
    throw new Error(`CONTAINER_RUNTIME_MISSING: ${canonical} could not be inspected: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!st.isFile()) {
    throw new Error(`CONTAINER_RUNTIME_NOT_FILE: ${canonical} is not a regular file`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`CONTAINER_RUNTIME_IS_SYMLINK: ${canonical} is a symbolic link`);
  }

  return canonical;
}

/**
 * Runner-owned sandbox command helper. The timeout comes from the manifest
 * bounds (seconds), never a hardcoded constant.
 */
async function runRealSandboxCommand(
  containerRuntime: 'docker' | 'podman',
  sandboxImage: string,
  workspacePath: string,
  command: readonly string[],
  timeoutSeconds: number,
  sandboxIdentity = resolveSandboxIdentity(),
): Promise<GreenEvidence> {
  const runtimePath = resolveContainerRuntime(containerRuntime);
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
      try {
        child.kill('SIGTERM');
      } catch {}
      sigkillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 10_000);
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

export function writeValidatedEvidence(evidence: TaskRunEvidence, path: string): void {
  const validated = validateTaskRunEvidence(evidence);
  if (!validated.ok) {
    throw new Error(`task-run evidence validation failed: ${validated.error}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2));
}

/** Resolve the configured branch at execution time through harness-owned Git. */
function resolveConfiguredBaseCommit(gitPath: string, pool: RepositoryBoundPoolConfig): string {
  const topLevel = hardenedGit(gitPath, pool.repositoryRoot, ['rev-parse', '--show-toplevel']);
  if (!topLevel.ok || topLevel.stdout !== pool.repositoryRoot) {
    throw new Error('CONFIGURED_REPOSITORY_IDENTITY_INVALID: repository root no longer identifies the configured Git worktree');
  }
  const resolved = hardenedGit(gitPath, pool.repositoryRoot, ['rev-parse', '--verify', `${pool.baseRef}^{commit}`]);
  if (!resolved.ok || !/^[0-9a-f]{40}$/.test(resolved.stdout)) {
    throw new Error('CONFIGURED_BASE_REF_UNRESOLVABLE: configured branch did not resolve to a commit');
  }
  return resolved.stdout;
}

/**
 * Execute frozen pool policy plus task content. The generated snapshot is
 * private to this function: no caller can choose its path or override fields.
 */
async function runConfiguredPoolTask(pool: RepositoryBoundPoolConfig, task: RepositoryBoundTaskContent, host: ConfiguredPoolHostOptions): Promise<TaskRunResult> {
  let executionRoot: string | undefined;
  let handedOff = false;
  try {
    const runtimeStat = lstatSync(pool.runtimeRoot);
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory() || realpathSync(pool.runtimeRoot) !== pool.runtimeRoot) {
      throw new Error('CONFIGURED_RUNTIME_ROOT_INVALID: runtime root changed after startup');
    }
    const baseCommit = resolveConfiguredBaseCommit(host.preflight.gitPath, pool);
    executionRoot = realpathSync(mkdtempSync(join(pool.runtimeRoot, 'execution-')));
    if (!executionRoot.startsWith(`${pool.runtimeRoot}${sep}`)) {
      throw new Error('CONFIGURED_RUNTIME_ROOT_INVALID: allocated workspace escaped configured runtime root');
    }
    const snapshotPath = join(executionRoot, '.configured-execution-snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify({
      schema_version: 1,
      task_id: task.taskId,
      target_repo_path: pool.repositoryRoot,
      base_commit: baseCommit,
      intent: task.intent,
      change_spec: task.changeSpec,
      acceptance_criteria: task.acceptanceCriteria,
      allowed_changed_paths: pool.allowedChangedPaths,
      verification_commands: pool.verificationCommands,
      model: pool.model,
      bounds: { verification_timeout_seconds: pool.bounds.verificationTimeoutSeconds },
    }));
    handedOff = true;
    return await runTaskInternal({
      manifestPath: snapshotPath,
      preflight: host.preflight,
      containerRuntime: host.containerRuntime,
      sandboxImage: host.sandboxImage,
      adapterProvenance: host.adapterOverrides ? { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' } : { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      ...(host.adapterOverrides ? { adapterOverrides: host.adapterOverrides } : {}),
      executionRoot,
      launchTimeoutSeconds: pool.bounds.launchTimeoutSeconds,
    });
  } finally {
    // runTask owns the root after handoff; failed setup must not leave it behind.
    if (executionRoot && !handedOff) rmSync(executionRoot, { recursive: true, force: true });
  }
}

/** Binds frozen owner policy and host adapters once; queued calls preserve one-slot execution. */
export function createConfiguredRepositoryBoundPool(
  pool: RepositoryBoundPoolConfig,
  host: ConfiguredPoolHostOptions,
): ConfiguredRepositoryBoundPool {
  let tail: Promise<void> = Promise.resolve();
  return Object.freeze({
    run(task: RepositoryBoundTaskContent): Promise<TaskRunResult> {
      const content = createRepositoryBoundTaskContent(task);
      const next = tail.then(() => runConfiguredPoolTask(pool, content, host));
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
  });
}

/** Legacy reviewed-manifest adapter. */
export async function runTask(options: RunTaskOptions): Promise<TaskRunResult> {
  return runTaskInternal(options);
}

async function runTaskInternal(options: InternalRunTaskOptions): Promise<TaskRunResult> {
  // 1. Strict manifest validation: the only work before this point is reading
  // the file. No store, clone, candidate directory, or adapter effect exists.
  const loaded = loadTaskManifest(options.manifestPath);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason, failureCode: loaded.code, report: null, evidencePath: null };
  }
  const manifest = loaded.manifest;

  if (options.modelOverride !== undefined && options.modelOverride !== manifest.model) {
    return {
      ok: false,
      reason: `--model ${options.modelOverride} does not equal manifest model ${manifest.model}`,
      failureCode: 'TASK_MODEL_MISMATCH',
      report: null,
      evidencePath: null,
    };
  }

  // 2. Adapter entry-point rules (run-stage-2 pattern): overrides require
  // explicit fake provenance; fake provenance requires overrides.
  const hasFake = Object.values(options.adapterProvenance).some((v) => v === 'fake');
  const hasOverrides = options.adapterOverrides !== undefined;
  if (hasOverrides && !hasFake) {
    return {
      ok: false,
      reason: 'production task run rejected adapter overrides with all-real provenance',
      failureCode: 'POOL_PROOF_REAL_ADAPTER_OVERRIDE_REJECTED',
      report: null,
      evidencePath: null,
    };
  }
  if (hasFake && !hasOverrides) {
    return {
      ok: false,
      reason: 'production task run rejected fake adapters',
      failureCode: 'POOL_PROOF_FAKE_ADAPTER_REJECTED',
      report: null,
      evidencePath: null,
    };
  }

  // 3. Candidate-output guard fires before any side effect and before any
  // mkdirSync, including for not-yet-existing subdirectories of reports/.
  let evidencePath: string;
  try {
    evidencePath = options.reportOutputPath !== undefined
      ? resolveCandidateOutputPath(options.reportOutputPath)
      : join(mkdtempSync(join(tmpdir(), 'pool-proof-task-candidate-')), EVIDENCE_FILENAME);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      failureCode: e instanceof Error && e.message.startsWith('TASK_OUTPUT_INSIDE_RETAINED_REPORTS')
        ? 'TASK_OUTPUT_INSIDE_RETAINED_REPORTS'
        : 'TASK_OUTPUT_REJECTED',
      report: null,
      evidencePath: null,
    };
  }

  const gitPath = options.preflight.gitPath;
  const timeoutSeconds = manifest.bounds.verification_timeout_seconds;
  const sandboxIdentity = resolveSandboxIdentity();
  const sandboxRunner: (workspacePath: string, command: readonly string[]) => Promise<GreenEvidence> =
    options.adapterOverrides?.runSandboxCommand !== undefined
      ? (workspacePath, command) => options.adapterOverrides!.runSandboxCommand!(workspacePath, command, timeoutSeconds)
      : (workspacePath, command) => runRealSandboxCommand(options.containerRuntime, options.sandboxImage, workspacePath, command, timeoutSeconds, sandboxIdentity);

  let store: OrchestrationStore | undefined;
  let runtimeRoot: string | undefined;
  let workspaceTemp: string | undefined;
  let cleaned = false;

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    if (store) {
      try {
        await store.close();
      } catch {
        // bounded cleanup failure
      }
      store = undefined;
    }
    for (const dir of [runtimeRoot, workspaceTemp]) {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // bounded cleanup failure
        }
      }
    }
    runtimeRoot = undefined;
    workspaceTemp = undefined;
  }

  const startedAt = new Date();
  try {
    // 4. Fresh isolated workspace at the pinned base commit.
    options.sideEffectObserver?.('clone');
    runtimeRoot = options.executionRoot ?? realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-task-runtime-')));
    workspaceTemp = realpathSync(mkdtempSync(join(runtimeRoot, 'workspace-')));
    const workspacePath = join(workspaceTemp, 'task-workspace');
    try {
      prepareTaskWorkspace(gitPath, manifest.target_repo_path, workspacePath, manifest.base_commit);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await cleanup();
      return {
        ok: false,
        reason: message,
        failureCode: /^(TASK_[A-Z_]+|BASE_[A-Z_]+)/.exec(message)?.[0] ?? 'TASK_WORKSPACE_FAILED',
        report: null,
        evidencePath: null,
      };
    }
    prepareWorkspaceForSandbox(workspacePath, sandboxIdentity);

    // 5. Informational base-state command evidence (never gates the run).
    options.sideEffectObserver?.('sandbox');
    const baseStateEvidence: { command: readonly string[]; exit_code: number; timed_out: boolean }[] = [];
    {
      const baseEvidence = await sandboxRunner(workspacePath, manifest.verification_commands[0]);
      baseStateEvidence.push({ command: [...baseEvidence.command], exit_code: baseEvidence.exitCode, timed_out: baseEvidence.timedOut });
    }

    // 6. Minimal Pool Runtime composition, parameterized only by the manifest.
    options.sideEffectObserver?.('store');
    store = await createSqliteStore({ runtimeRoot, dbLocation: 'task-run.db' });
    const persistence = createPoolProofPersistence(store);

    options.sideEffectObserver?.('resource');
    const brokerSocketRoot = resolveShortSocketRoot();
    const resourceFactory = createAttemptResourceFactory({ runtimeRoot, socketRoot: brokerSocketRoot });
    const attemptResources = new Map<string, AttemptResources>();

    const nodeId = `task-${manifest.task_id}`;
    const attemptId = `${nodeId}-attempt-1`;
    const job: ProofJob = {
      nodeId,
      attemptId,
      attemptNumber: 1,
      intent: manifest.intent,
      changeSpec: manifest.change_spec,
      acceptanceCriteria: manifest.acceptance_criteria.map((c) => ({ id: c.id, text: c.text })),
      criteriaOriginSource: 'direct_task',
      criteriaOriginSourceId: manifest.task_id,
      targetRepo: manifest.task_id,
      targetBranch: 'detached',
      allowedChangedPaths: [...manifest.allowed_changed_paths],
      fixtureTestCommand: [...manifest.verification_commands[0]],
      workspacePath,
    };

    const launchIdentity: PoolProofLaunchExpectations = {
      nodeId: job.nodeId,
      attemptId: job.attemptId,
      targetRepo: job.targetRepo,
      targetBranch: job.targetBranch,
      workspacePath,
      piRuntimeParent: join(runtimeRoot, 'pi-runtime'),
      piSessionDir: join(runtimeRoot, 'pi-session'),
      piExecutablePath: options.preflight.pi.path,
      piExecutableVersion: options.preflight.pi.version,
      piExecutableDigest: options.preflight.pi.digest,
      packagePath: options.preflight.package.path,
      packageProfile: options.preflight.package.profile,
      packageDigest: options.preflight.package.digest,
      profileName: options.preflight.profile.name,
      profilePath: options.preflight.profile.path,
      profileDigest: options.preflight.profile.digest,
      selectedModel: manifest.model,
      toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      resultDestinationId: attemptId,
    };

    const verifyPackageAndProfile = async (_packagePath: string, packageDigest: string, _profilePath: string, profileDigest: string) => {
      const currentPackage = resolvePackageIdentity();
      const currentProfile = resolveProfileIdentity();
      return currentPackage.digest === packageDigest && currentProfile.digest === profileDigest;
    };

    type ProcessDiagnostic = {
      exit_code: number | null;
      signal_code: NodeJS.Signals | null;
      timed_out: boolean;
      pid_present: boolean;
    };
    let processDiagnostic: ProcessDiagnostic = {
      exit_code: null,
      signal_code: null,
      timed_out: false,
      pid_present: false,
    };
    let resultId: string = attemptId;

    const runtime = createMinimalPoolRuntime({
      resourceFactory: {
        allocate: (id: string, workspacePath?: string) => {
          const resources = resourceFactory.allocate(id, workspacePath);
          attemptResources.set(id, resources);
          return resources;
        },
        release: (resources: AttemptResources) => resourceFactory.release(resources),
      },
      createPiLauncher: (expectations, runtimeJob) => {
        options.sideEffectObserver?.('adapter');
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
            // Configured pools never consult ambient POOL_PROOF_TIMEOUT_MS.
            ...(options.launchTimeoutSeconds === undefined ? {} : { timeoutMs: options.launchTimeoutSeconds * 1000 }),
          },
          verifyPackageAndProfile,
        });
      },
      selectedModel: manifest.model,
      launchIdentity,
      // The runtime is a trusted internal boundary: runTask owns fake-adapter
      // truth at the entry point (overrides require explicit fake provenance).
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      slotCount: 1,
      persistAttempt: async ({ attemptId: pid, nodeId: nid, selectedModel: sm, resultId: rid }) => {
        resultId = rid;
        await persistence.importWorkAndCreateAttempt(
          {
            work_id: `task-run-${manifest.task_id}`,
            origin: 'direct_task',
            repo: job.targetRepo,
            branch: job.targetBranch,
            payload_hash: `sha256:task-manifest:${loaded.manifest_sha256}`,
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
          rid,
          { builder: sm, policyVersion: 1 },
        );
      },
      verify: async (resources: AttemptResources, runtimeJob: ProofJob, process: PiProcess) => {
        // Bounded, runner-owned process outcome; PiProcess.output never enters evidence.
        processDiagnostic.exit_code = process.exitCode;
        processDiagnostic.signal_code = process.signalCode;
        processDiagnostic.timed_out = process.timedOut;
        processDiagnostic.pid_present = Number.isSafeInteger(process.pid) && process.pid > 0;

        // The verifier consumes the first verification command with the pinned
        // base commit as expected parent.
        const verifier = createPoolProofVerifier({
          gitPath,
          fixtureTestRunner: (cwd, command) => sandboxRunner(cwd, command),
          hasConflictingResult: persistence.hasConflictingResult,
        });
        const verdict = await verifier.verify(
          resources,
          {
            ...runtimeJob,
            fixtureTestCommand: manifest.verification_commands[0],
            expectedParentCommit: manifest.base_commit,
          },
          process,
        );

        // The runner evaluates the remaining commands through the same sandbox
        // helper and merges the checks.
        const mergedChecks = [...verdict.checks];
        let greenEvidence = verdict.greenEvidence;
        let remainingFailed = false;
        for (let index = 1; index < manifest.verification_commands.length; index += 1) {
          const command = manifest.verification_commands[index];
          const evidence = await sandboxRunner(resources.workspacePath, command);
          const passed = evidence.exitCode === 0 && !evidence.timedOut;
          mergedChecks.push({ name: `verification_command_${index + 1}`, passed });
          if (!passed) remainingFailed = true;
          if (!greenEvidence && passed) greenEvidence = evidence;
        }
        const allPassed = mergedChecks.every((c) => c.passed);
        return {
          status: allPassed ? 'passed' as const : 'failed' as const,
          commitSha: allPassed ? verdict.commitSha : null,
          failureCode: allPassed
            ? null
            : (verdict.failureCode ?? (remainingFailed ? 'VERIFICATION_COMMAND_FAILED' : 'VERIFIER_CHECK_FAILED')),
          checks: mergedChecks,
          greenEvidence: allPassed ? greenEvidence : null,
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

    let resultCommit: string | null = null;
    let checks: { name: string; passed: boolean }[];
    let failureCode: string | null;
    if (submitResult.ok) {
      const persisted = await persistence.getResult(submitResult.attemptId);
      resultCommit = persisted?.commit_sha ?? null;
      checks = (await persistence.getChecks(submitResult.attemptId)).map((c: ProofCheckRecord) => ({ name: c.check_name, passed: c.passed === 1 }));
      failureCode = submitResult.status === 'passed' ? null : (persisted?.failure_code ?? 'TASK_VERIFIER_CHECK_FAILED');
    } else {
      checks = [{ name: 'runtime_submit', passed: false }];
      failureCode = submitResult.error;
    }

    // Capture the runtime-reported cleanup disposition before the roots are removed.
    const cleanupDisposition = submitResult.cleanupDisposition
      ?? { attemptRootRemoved: false, workspaceRemoved: false, errors: ['runtime did not report cleanup disposition'] };
    const sessionStillExists = existsSync(join(runtimeRoot, 'pi-session'));

    const evidence = buildTaskRunEvidence({
      manifest_sha256: loaded.manifest_sha256,
      task_id: manifest.task_id,
      base_commit: manifest.base_commit,
      attempt_id: attemptId,
      result_id: resultId,
      selected_model: manifest.model,
      status: submitResult.ok && submitResult.status === 'passed' ? 'passed' : 'failed',
      process: processDiagnostic,
      result_commit: resultCommit,
      checks,
      base_state_evidence: baseStateEvidence,
      cleanup_disposition: {
        workspace_removed: cleanupDisposition.workspaceRemoved,
        session_removed: cleanupDisposition.attemptRootRemoved && !sessionStillExists,
      },
      started_at: startedAt,
      finished_at: finishedAt,
      failure_code: failureCode,
      failure_detail: cleanupDisposition.errors.length > 0 ? cleanupDisposition.errors.join('; ') : null,
    });

    await cleanup();
    try {
      writeValidatedEvidence(evidence, evidencePath);
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
        failureCode: 'TASK_EVIDENCE_VALIDATION_FAILED',
        report: evidence,
        evidencePath,
      };
    }
    return { ok: true, report: evidence, evidencePath };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const evidence = buildTaskRunEvidence({
      manifest_sha256: loaded.manifest_sha256,
      task_id: manifest.task_id,
      base_commit: manifest.base_commit,
      attempt_id: `task-${manifest.task_id}-attempt-1`,
      result_id: `task-${manifest.task_id}-attempt-1`,
      selected_model: manifest.model,
      status: 'failed',
      process: { exit_code: null, signal_code: null, timed_out: false, pid_present: false },
      result_commit: null,
      checks: [{ name: 'runtime_exception', passed: false }],
      base_state_evidence: [],
      cleanup_disposition: { workspace_removed: false, session_removed: false },
      started_at: startedAt,
      finished_at: new Date(),
      failure_code: 'RUNTIME_EXCEPTION',
      failure_detail: message,
    });
    await cleanup();
    try {
      writeValidatedEvidence(evidence, evidencePath);
    } catch {
      // bounded evidence write failure on the exception path
    }
    return { ok: false, reason: message, failureCode: 'RUNTIME_EXCEPTION', report: evidence, evidencePath };
  } finally {
    await cleanup();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifestFlag = args.indexOf('--manifest');
  const modelFlag = args.indexOf('--model');
  const runtimeFlag = args.indexOf('--container-runtime');
  const imageFlag = args.indexOf('--sandbox-image');
  const piFlag = args.indexOf('--pi');
  const manifestPath = manifestFlag >= 0 ? args[manifestFlag + 1] : undefined;
  const modelOverride = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
  const containerRuntime = parseContainerRuntime(runtimeFlag >= 0 ? (args[runtimeFlag + 1] ?? '') : 'docker');
  const sandboxImage = imageFlag >= 0 ? args[imageFlag + 1] : undefined;
  const piPath = piFlag >= 0 ? args[piFlag + 1] : undefined;

  if (!manifestPath) {
    console.error('an explicit reviewed --manifest path is required (process-level review trust)');
    process.exit(1);
  }
  if (!sandboxImage) {
    console.error('sandbox image digest/ID is required');
    process.exit(1);
  }

  // Validate the manifest before preflight so malformed manifests fail before
  // any capability probing or model work.
  const loaded = loadTaskManifest(manifestPath);
  if (!loaded.ok) {
    console.error(`task manifest rejected: ${loaded.code} - ${loaded.reason}`);
    process.exit(1);
  }
  if (modelOverride !== undefined && modelOverride !== loaded.manifest.model) {
    console.error(`task model mismatch: --model ${modelOverride} does not equal manifest model ${loaded.manifest.model}`);
    process.exit(1);
  }

  const preflight = await runPreflight({ piPath, model: loaded.manifest.model, containerRuntime, sandboxImage });
  if (!preflight.ok) {
    console.error(`preflight failed: ${preflight.failure.stage} - ${preflight.failure.reason}`);
    process.exit(1);
  }

  const result = await runTask({
    manifestPath,
    preflight: preflight.result,
    containerRuntime,
    sandboxImage,
    adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
    ...(modelOverride !== undefined ? { modelOverride } : {}),
  });

  if (!result.ok) {
    console.error(`task run failed: ${result.failureCode} - ${result.reason}`);
    process.exit(1);
  }
  if (result.report.status !== 'passed') {
    console.error(`task run did not pass: ${result.report.diagnostics.failure_code}`);
    process.exit(1);
  }
  console.log(`Task run passed; candidate evidence: ${result.evidencePath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
