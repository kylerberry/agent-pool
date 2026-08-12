/**
 * Stage 2 real proof entry point.
 *
 * Loads the retained Stage 1 report, validates it and recomputes its SHA-256
 * before any side effect, then runs three independent fixture jobs through the
 * public Minimal Pool Runtime with two persistent slots. One real spawned
 * Worker receives a deterministic proof-only fault directive; the other two
 * complete independently. The harness reconciles SQLite, verifier outcomes, and
 * isolation evidence into a schema-valid Stage 2 report.
 *
 * The production entry point rejects fake adapters. Tests may compose the
 * exported runStage2 function with controlled fake adapters.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  cpSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMinimalPoolRuntime,
  createPoolProofPiLauncher,
  createAttemptResourceFactory,
  resolveShortSocketRoot,
  type ProofJob,
  type AttemptResources,
  type PiProcess,
  type PiLauncher,
  type PoolProofLaunchExpectations,
  type PackageProfileVerifier,
} from '../../../src/domains/agent-execution/index.ts';
import type { AdapterProvenance } from '../../../src/domains/agent-execution/minimal-pool-runtime.ts';
import { createPoolProofVerifier } from '../../../src/domains/verification/pool-proof-verifier.ts';
import {
  createSqliteStore,
  createPoolProofPersistence,
  type ProofCheckRecord,
  type OrchestrationStore,
} from '../../../src/domains/orchestration/index.ts';
import type { ApprovedModelId } from '../../../src/domains/model-routing-and-evaluation/approved-models.ts';
import { isApprovedModelId } from '../../../src/domains/model-routing-and-evaluation/approved-models.ts';
import { prepareWorkspaceForSandbox, resolveSandboxIdentity } from '../../../src/domains/agent-execution/sandbox-identity.ts';
import { resolvePackageIdentity, resolveProfileIdentity } from './identity-resolution.ts';
import { initializeFixtureRepository, loadFixtureManifest } from './fixture-repository.ts';
import { validateReport as validateStage1Report, type Stage1ProofReport } from './report.ts';
import { attemptBindingHash, buildStage2Report, validateStage2Report, type Stage2AttemptReport, type Stage2ProofReport } from './stage-2-report.ts';
import { deriveCommitments, validateRawObservations, type RawStage2Observation } from './stage-2-isolation.ts';
import { buildActorIdentity } from '../../../src/domains/agent-execution/actor-context.ts';
import { runPreflight, type PreflightSuccess } from './preflight.ts';
import type { GreenEvidence } from '../../../src/domains/verification/pool-proof-verifier.ts';
import type { ApprovedWork } from '../../../src/domains/orchestration/contracts.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = resolve(packageRoot, 'reports');
const stage1ReportPath = resolve(reportsDir, 'stage-1-proof-report.json');
const stage2ReportPath = resolve(reportsDir, 'stage-2-proof-report.json');
const stage2FailurePath = resolve(reportsDir, 'stage-2-preflight-failure.json');

const SANDBOX_CPU = '1';
const SANDBOX_MEMORY = '1g';
const SANDBOX_PIDS = 64;
/** Per-stream receipt cap; excess bytes are discarded before they accumulate. */
export const SANDBOX_OUTPUT_CAP_BYTES = 4096;

/**
 * Bounded, redacted per-attempt diagnostic collected only when a Stage 2 run
 * fails. Never contains output, prompts, transcripts, environment values,
 * secrets, task text, or raw workspace/session paths.
 */
export type Stage2ProcessDiagnostic = {
  readonly exit_code: number | null;
  readonly signal_code: NodeJS.Signals | null;
  readonly timed_out: boolean;
  readonly pid_present: boolean;
};

export type Stage2AttemptDiagnostic = {
  readonly attempt_id: string;
  readonly slot_index: number;
  readonly submit_ok: boolean;
  readonly submit_status: string | null;
  readonly submit_error: string | null;
  readonly error_detail: string | null;
  readonly persisted_status: string | null;
  readonly persisted_failure_code: string | null;
  readonly persisted_result_present: boolean;
  readonly verifier_checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly launcher_injected_fault: boolean;
  readonly cleanup_workspace_removed: boolean;
  readonly cleanup_attempt_root_removed: boolean;
  readonly cleanup_error_count: number;
  /** Captured by attempt ID when the runtime calls verify; never includes Pi output. */
  readonly process: Stage2ProcessDiagnostic | null;
};

const DETAIL_CAP = 300;

function redactAndCap(value: string | undefined | null, cap = DETAIL_CAP): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  let s = value;
  // Redact known API key environment assignments.
  s = s.replace(/(?:MOONSHOT_API_KEY|ZAI_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|ANTHROPIC_API_KEY)\s*=\s*\S+/gi, '[REDACTED]');
  // Redact OpenAI-style keys.
  s = s.replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED]');
  // Redact generic credential assignments.
  s = s.replace(/(?:api[_-]?key|token|secret|password|credential|auth[_-]?token)["'\s:=]+[A-Za-z0-9_\-./+=]{8,}/gi, '[REDACTED]');
  // Redact absolute unix paths (common host temp/user/runtime roots).
  s = s.replace(/(\/(?:Users|var|tmp|private|home|opt|usr|etc|root)[^\s"')\]]*)/g, '[REDACTED_PATH]');
  if (s.length > cap) {
    s = s.slice(0, cap) + '…';
  }
  return s;
}

export type Stage1GateResult =
  | { ok: true; report: Stage1ProofReport; sha256: string }
  | { ok: false; reason: string };

export function loadAndValidateStage1Report(path: string): Stage1GateResult {
  if (!existsSync(path)) {
    return { ok: false, reason: `Stage 1 report not found at ${path}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read Stage 1 report: ${e instanceof Error ? e.message : String(e)}` };
  }

  const sha256 = createHash('sha256').update(raw).digest('hex');
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'Stage 1 report is not valid JSON' };
  }
  const validated = validateStage1Report(report);
  if (!validated.ok) {
    return { ok: false, reason: `Stage 1 report validation failed: ${validated.error}` };
  }
  const stage1 = report as Stage1ProofReport;
  if (stage1.status !== 'passed') {
    return { ok: false, reason: 'Stage 1 report did not pass' };
  }
  if (!isApprovedModelId(stage1.model)) {
    return { ok: false, reason: `Stage 1 report model ${stage1.model} is not an approved builder model` };
  }
  if (stage1.fake_adapter !== false) {
    return { ok: false, reason: 'Stage 1 report relied on a fake adapter' };
  }
  if (!stage1.cleanup_disposition.workspace_removed || !stage1.cleanup_disposition.session_removed) {
    return { ok: false, reason: 'Stage 1 report did not record complete cleanup' };
  }
  if (stage1.verifier_checks.length === 0 || !stage1.verifier_checks.every((c) => c.passed)) {
    return { ok: false, reason: 'Stage 1 report did not record passing verifier checks' };
  }
  if (stage1.red_evidence.exit_code === 0) {
    return { ok: false, reason: 'Stage 1 report red evidence did not fail at base' };
  }
  if (stage1.green_evidence.exit_code !== 0) {
    return { ok: false, reason: 'Stage 1 report green evidence did not pass' };
  }
  return { ok: true, report: stage1, sha256 };
}

export function appendSandboxOutput(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = SANDBOX_OUTPUT_CAP_BYTES - Buffer.byteLength(current, 'utf8');
  if (remaining <= 0) return { value: current, truncated: bytes.length > 0 };
  if (bytes.length <= remaining) return { value: current + bytes.toString('utf8'), truncated: false };
  return { value: current + bytes.subarray(0, remaining).toString('utf8'), truncated: true };
}

function resolveContainerRuntime(containerRuntime: 'docker' | 'podman'): string {
  try {
    return execFileSync('command', ['-v', containerRuntime], { encoding: 'utf8', shell: true }).trim();
  } catch {
    throw new Error(`container runtime executable not found: ${containerRuntime}`);
  }
}

export async function runSandboxCommand(
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
    }, 120_000);
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
      resolve({
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

type VerifierVerdict = {
  readonly status: 'passed' | 'failed';
  readonly commitSha: string | null;
  readonly failureCode: string | null;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
};

type PersistedResultFact = {
  readonly result_id: string;
  readonly status: 'passed' | 'failed';
  readonly commit_sha: string | null;
  readonly failure_code: string | null;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
};

function rawObservationFor(resources: AttemptResources | undefined, job: Stage2Job, verifier: VerifierVerdict | undefined, persisted: PersistedResultFact | null, process: PiProcess | undefined, fakeProvenance: boolean): RawStage2Observation {
  if (!resources || !verifier || !persisted) throw new Error(`STAGE2_ISOLATION_INVALID: missing allocator, verifier, or persisted observation for ${job.attemptId}`);
  // Production accepts only exact artifacts issued by the launcher. The fake
  // branch exists solely to let adapter-composed tests reach the runner seam.
  const issued = process?.issuedArtifacts;
  if (!issued && !fakeProvenance) throw new Error(`STAGE2_ISOLATION_INVALID: launcher artifacts missing for ${job.attemptId}`);
  const context = issued?.executionContext ?? {
    schema_version: 3, actor: 'pool-worker', node_id: job.nodeId, attempt_id: job.attemptId, attempt_nonce: resources.nonce,
    issued_by: 'agent-pool-runtime', issued_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T00:03:00.000Z', max_age_seconds: 180,
    target_repo: job.job.targetRepo, target_branch: job.job.targetBranch, workspace_path: resources.workspacePath,
    pi_runtime_parent: resources.piRuntimeParent, pi_session_dir: resources.piSessionDir,
    pi_executable_identity: { path: 'fake', version: 'fake', digest: '0'.repeat(64) }, package_identity: { path: 'fake', profile: 'fake', digest: '0'.repeat(64) }, profile_identity: { name: 'fake', path: 'fake', digest: '0'.repeat(64) }, selected_model: 'moonshot/kimi-k2.7-code', tool_grants: ['read'], result_destination: { kind: 'sqlite', id: resources.resultId },
  };
  const contract = issued?.attemptContract ?? {
    schema_version: 1, node_id: job.nodeId, attempt_id: job.attemptId, attempt_number: job.job.attemptNumber, intent: job.job.intent, change_spec: job.job.changeSpec,
    acceptance_criteria: job.job.acceptanceCriteria, criteria_origin: { source: job.job.criteriaOriginSource, source_id: job.job.criteriaOriginSourceId }, target_repo: job.job.targetRepo, target_branch: job.job.targetBranch, prior_failure_context: [],
  };
  return {
    attemptId: job.attemptId, nodeId: job.nodeId,
    verifier,
    persisted: { resultId: persisted.result_id, status: persisted.status, commitSha: persisted.commit_sha, failureCode: persisted.failure_code, checks: persisted.checks },
    // This result identity is allocator-owned. Do not substitute the row value
    // being checked for it.
    workspace: resources.workspacePath, piSession: resources.piSessionDir, nonce: resources.nonce, resultId: resources.resultId,
    repositoryInstance: job.fixturePath, privateRuntime: resources.piRuntimeParent, broker: resources.brokerSocketPath ?? 'no-broker',
    inventory: { workspace: resources.workspacePath, privateRuntime: resources.piRuntimeParent, session: resources.piSessionDir, broker: resources.brokerSocketPath ?? 'no-broker', resultId: resources.resultId },
    executionContext: context, actorIdentity: issued?.actorIdentity ?? buildActorIdentity(context), attemptContract: contract,
    resourceAttemptId: resources.attemptId, expected: { workspace: job.fixturePath, targetRepo: job.job.targetRepo, targetBranch: job.job.targetBranch, nodeId: job.nodeId, attemptId: job.attemptId },
  };
}

function isValidBaseRed(evidence: GreenEvidence): boolean {
  return evidence.exitCode !== 0 && !evidence.timedOut;
}

function cloneInitializedFixture(sourcePath: string, targetPath: string): void {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true });
  }
  mkdirSync(targetPath, { recursive: true });
  // Copy the initialized source fixture including its .git directory so each
  // clone has the deterministic base commit and history.
  cpSync(sourcePath, targetPath, { recursive: true });
  prepareWorkspaceForSandbox(targetPath);
}

export type Stage2Job = {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly fixturePath: string;
  readonly baseCommit: string;
  readonly job: ProofJob;
};

export function buildStage2Jobs(
  fixtureSourcePath: string,
  fixtureCloneRoot: string,
  baseCommit: string,
): Stage2Job[] {
  const manifest = loadFixtureManifest();
  return [
    { nodeId: 'multi-worker-pool-proof-a', attemptId: 'multi-worker-pool-proof-attempt-a' },
    { nodeId: 'multi-worker-pool-proof-b', attemptId: 'multi-worker-pool-proof-attempt-b' },
    { nodeId: 'multi-worker-pool-proof-c', attemptId: 'multi-worker-pool-proof-attempt-c' },
  ].map(({ nodeId, attemptId }) => {
    const fixturePath = join(fixtureCloneRoot, attemptId);
    cloneInitializedFixture(fixtureSourcePath, fixturePath);
    const job: ProofJob = {
      nodeId,
      attemptId,
      attemptNumber: 1,
      intent: `Stage 2 fixture job ${attemptId}`,
      changeSpec: 'Apply the deterministic fixture change and verify it.',
      acceptanceCriteria: [
        { id: `${attemptId}/base-red`, text: 'Fixture tests fail at the base commit before the Worker runs.' },
        { id: `${attemptId}/green`, text: 'Fixture tests pass after the Worker commit.' },
      ],
      criteriaOriginSource: 'direct_task',
      criteriaOriginSourceId: manifest.fixture_name,
      targetRepo: manifest.fixture_name,
      targetBranch: 'main',
      allowedChangedPaths: [...manifest.allowed_changed_paths],
      fixtureTestCommand: [...manifest.fixture_test_command],
      workspacePath: fixturePath,
    };
    return { nodeId, attemptId, fixturePath, baseCommit, job };
  });
}

export type Stage2Options = {
  readonly stage1ReportPath: string;
  readonly stage2ReportPath: string;
  readonly preflight: PreflightSuccess;
  readonly model: ApprovedModelId;
  readonly containerRuntime: 'docker' | 'podman';
  readonly sandboxImage: string;
  readonly adapterProvenance: AdapterProvenance;
  readonly injectFaultAttemptId: string;
  readonly fixtureSourcePath: string;
  /** Test-only observable seams for proving the Stage 1 gate precedes all effects. */
  readonly sideEffectObserver?: (effect: 'fixture' | 'store' | 'resource' | 'preflight' | 'adapter') => void;
  /** Fake-provenance-only test seam immediately before raw validation/derivation. */
  readonly mutateRawObservationsForTest?: (observations: readonly RawStage2Observation[]) => readonly RawStage2Observation[];
  /**
   * Test-only overrides. When present, the harness bypasses real Pi/Docker
   * adapters for the corresponding seam. Production callers must not supply
   * overrides.
   */
  readonly adapterOverrides?: {
    readonly createPiLauncher?: (expectations: PoolProofLaunchExpectations, job: ProofJob) => PiLauncher;
    readonly verify?: (resources: AttemptResources, job: ProofJob, process: PiProcess) => Promise<{
      status: 'passed' | 'failed';
      commitSha: string | null;
      failureCode: string | null;
      checks: readonly { readonly name: string; readonly passed: boolean }[];
      greenEvidence: GreenEvidence | null;
    }>;
    readonly runBaseRed?: (fixturePath: string) => Promise<GreenEvidence>;
  };
};

export type Stage2Result =
  | { ok: true; report: Stage2ProofReport; stage1Sha256: string }
  | { ok: false; reason: string; failureCode?: string; attempt_diagnostics?: readonly Stage2AttemptDiagnostic[] };

export async function runStage2(options: Stage2Options): Promise<Stage2Result> {
  const gate = loadAndValidateStage1Report(options.stage1ReportPath);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason, failureCode: 'STAGE_1_GATE_FAILED' };
  }

  const stage1 = gate.report;

  // For real proof runs, fake adapters are rejected at the entry point.
  // Test-mode adapter overrides are allowed only together with explicit fake
  // provenance; production never supplies overrides. All-real + overrides is
  // rejected so a real proof cannot be silently substituted by test seams.
  const hasFake = Object.values(options.adapterProvenance).some((v) => v === 'fake');
  const hasOverrides = options.adapterOverrides !== undefined;
  if (options.mutateRawObservationsForTest && !hasFake) {
    return { ok: false, reason: 'production Stage 2 proof rejected raw observation mutation seam', failureCode: 'POOL_PROOF_REAL_RAW_MUTATION_REJECTED' };
  }
  if (hasOverrides && !hasFake) {
    return { ok: false, reason: 'production Stage 2 proof rejected adapter overrides with all-real provenance', failureCode: 'POOL_PROOF_REAL_ADAPTER_OVERRIDE_REJECTED' };
  }
  if (hasFake && !hasOverrides) {
    return { ok: false, reason: 'production Stage 2 proof rejected fake adapters', failureCode: 'POOL_PROOF_FAKE_ADAPTER_REJECTED' };
  }

  let runtimeRoot: string | undefined;
  let store: OrchestrationStore | undefined;
  let fixtureCloneRoot: string | undefined;
  let cleaned = false;
  let attemptDiagnostics: Stage2AttemptDiagnostic[] = [];

  type CleanupAggregate = {
    readonly storeClosed: boolean;
    readonly runtimeRootRemoved: boolean;
    readonly fixtureCloneRootRemoved: boolean;
    readonly errors: readonly string[];
  };
  let lastDisposition: CleanupAggregate = { storeClosed: true, runtimeRootRemoved: true, fixtureCloneRootRemoved: true, errors: [] };

  async function cleanup(): Promise<CleanupAggregate> {
    if (cleaned) return lastDisposition;
    cleaned = true;
    const errors: string[] = [];
    let storeClosed = true;
    let runtimeRootRemoved = true;
    let fixtureCloneRootRemoved = true;
    if (store) {
      try {
        await store.close();
      } catch (e) {
        storeClosed = false;
        errors.push(`store close failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      store = undefined;
    }
    if (runtimeRoot) {
      try {
        rmSync(runtimeRoot, { recursive: true, force: true });
      } catch (e) {
        runtimeRootRemoved = false;
        errors.push(`runtime root removal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      runtimeRoot = undefined;
    }
    if (fixtureCloneRoot) {
      try {
        rmSync(fixtureCloneRoot, { recursive: true, force: true });
      } catch (e) {
        fixtureCloneRootRemoved = false;
        errors.push(`fixture clone removal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      fixtureCloneRoot = undefined;
    }
    lastDisposition = { storeClosed, runtimeRootRemoved, fixtureCloneRootRemoved, errors };
    return lastDisposition;
  }

  try {
    options.sideEffectObserver?.('fixture');
    const { baseCommit } = initializeFixtureRepository(options.fixtureSourcePath);

    runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pool-proof-stage2-runtime-')));
    fixtureCloneRoot = join(runtimeRoot, 'fixtures');
    mkdirSync(fixtureCloneRoot, { recursive: true });
    options.sideEffectObserver?.('store');
    store = await createSqliteStore({ runtimeRoot, dbLocation: 'pool-proof.db' });
    const persistence = createPoolProofPersistence(store);

    const jobs = buildStage2Jobs(options.fixtureSourcePath, fixtureCloneRoot, baseCommit);

    const sandboxIdentity = resolveSandboxIdentity();

    // Run base-red for the fixture once on the source fixture; each clone will
    // get the same deterministic base commit. Tests may override this seam.
    options.sideEffectObserver?.('preflight');
    const redEvidence = options.adapterOverrides?.runBaseRed
      ? await options.adapterOverrides.runBaseRed(options.fixtureSourcePath)
      : await runSandboxCommand(
          options.containerRuntime,
          options.sandboxImage,
          options.fixtureSourcePath,
          ['node', '--test', 'test/message.test.js'],
          sandboxIdentity,
        );
    if (!isValidBaseRed(redEvidence)) {
      await cleanup();
      return { ok: false, reason: 'base red was invalid', failureCode: 'BASE_RED_INVALID' };
    }

    const work: ApprovedWork = {
      work_id: 'pool-proof-stage-2',
      origin: 'direct_task',
      repo: jobs[0].job.targetRepo,
      branch: jobs[0].job.targetBranch,
      payload_hash: 'sha256:pool-proof-stage2-fixture',
      nodes: jobs.map((j) => ({
        id: j.nodeId,
        intent: j.job.intent,
        change_spec: j.job.changeSpec,
        acceptance_criteria: j.job.acceptanceCriteria.map((c) => c.text),
        depends_on: [],
        criteria_origin_source: j.job.criteriaOriginSource,
        criteria_origin_source_id: j.job.criteriaOriginSourceId,
      })),
    };
    const imported = await store.importApprovedWork(work);
    if ('error' in imported) {
      await cleanup();
      return { ok: false, reason: `work import failed: ${imported.error.message}`, failureCode: 'WORK_IMPORT_FAILED' };
    }

    const launchIdentityBase: PoolProofLaunchExpectations = {
      nodeId: 'multi-worker-pool-proof',
      attemptId: 'multi-worker-pool-proof-attempt-a',
      targetRepo: jobs[0].job.targetRepo,
      targetBranch: jobs[0].job.targetBranch,
      workspacePath: jobs[0].fixturePath,
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
      selectedModel: options.model,
      toolGrants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      resultDestinationId: 'multi-worker-pool-proof-result-root',
    };

    const verifyPackageAndProfile: PackageProfileVerifier = async (_packagePath, packageDigest, _profilePath, profileDigest) => {
      const currentPackage = resolvePackageIdentity();
      const currentProfile = resolveProfileIdentity();
      return currentPackage.digest === packageDigest && currentProfile.digest === profileDigest;
    };

    const attemptResources = new Map<string, AttemptResources>();
    const processDiagnostics = new Map<string, Stage2ProcessDiagnostic>();
    const launchedProcesses = new Map<string, PiProcess>();
    // Independent verifier facts are captured at the verification boundary,
    // before persistence translates them into SQLite rows.
    const verifierVerdicts = new Map<string, VerifierVerdict>();
    // Allocate broker sockets under a launcher-owned short temp root so the
    // per-attempt Unix socket path stays under the macOS AF_UNIX limit even
    // though `runtimeRoot` is a long realpath-expanded user temp dir.
    const brokerSocketRoot = resolveShortSocketRoot();
    options.sideEffectObserver?.('resource');
    const resourceFactory = createAttemptResourceFactory({ runtimeRoot, socketRoot: brokerSocketRoot });

    const runtime = createMinimalPoolRuntime({
      resourceFactory: {
        allocate: (attemptId: string, workspacePath?: string) => {
          const resources = resourceFactory.allocate(attemptId, workspacePath);
          attemptResources.set(attemptId, resources);
          return resources;
        },
        release: (resources: AttemptResources) => resourceFactory.release(resources),
      },
      createPiLauncher: (runtimeExpectations, runtimeJob) => {
        options.sideEffectObserver?.('adapter');
        if (options.adapterOverrides?.createPiLauncher) {
          return options.adapterOverrides.createPiLauncher(runtimeExpectations, runtimeJob);
        }
        const resources = attemptResources.get(runtimeJob.attemptId);
        const socketPath = resources?.brokerSocketPath;
        if (!socketPath) {
          throw new Error('BROKER_SOCKET_NOT_ALLOCATED: Stage 2 requires a short broker socket path per attempt');
        }
        return createPoolProofPiLauncher({
          expectations: runtimeExpectations,
          job: runtimeJob,
          brokerOptions: {
            socketPath,
            workspacePath: runtimeExpectations.workspacePath,
            containerRuntime: options.containerRuntime,
            image: options.sandboxImage,
            cpuLimit: SANDBOX_CPU,
            memoryLimit: SANDBOX_MEMORY,
            pidsLimit: SANDBOX_PIDS,
            sandboxIdentity,
          },
          verifyPackageAndProfile,
          injectFaultForAttemptId: options.injectFaultAttemptId,
        });
      },
      selectedModel: options.model,
      launchIdentity: launchIdentityBase,
      // The runtime is a trusted internal boundary: runStage2 owns fake-adapter
      // truth at the entry point (overrides require explicit fake provenance).
      // The runtime always receives all-real provenance so its defense-in-depth
      // check does not block a legitimate test-mode composition.
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
      persistAttempt: async ({ attemptId: pid, nodeId: nid, selectedModel: sm, resultId }) => {
        const node = await store!.getApprovedNode(work.work_id, nid);
        if (!node) {
          throw new Error(`node not found: ${nid}`);
        }
        const transitioned = await store!.transitionNode(work.work_id, nid, 1, 'ready');
        if ('error' in transitioned) {
          throw new Error(`node transition failed: ${transitioned.error.message}`);
        }
        const attempt = await store!.createAttempt(work.work_id, nid, pid, 1, resultId, { builder: sm, policyVersion: 1 });
        if ('error' in attempt) {
          throw new Error(`attempt creation failed: ${attempt.error.message}`);
        }
      },
      verify: async (resources: AttemptResources, runtimeJob: ProofJob, process: PiProcess) => {
        // PiProcess.output is untrusted model output and must not enter diagnostics.
        launchedProcesses.set(runtimeJob.attemptId, process);
        processDiagnostics.set(runtimeJob.attemptId, {
          exit_code: process.exitCode,
          signal_code: process.signalCode,
          timed_out: process.timedOut,
          pid_present: Number.isSafeInteger(process.pid) && process.pid > 0,
        });
        const verdict = options.adapterOverrides?.verify
          ? await options.adapterOverrides.verify(resources, runtimeJob, process)
          : await createPoolProofVerifier({
              gitPath: options.preflight.gitPath,
              fixtureTestRunner: async (_cwd: string, command: readonly string[]) =>
                runSandboxCommand(options.containerRuntime, options.sandboxImage, resources.workspacePath, command),
              hasConflictingResult: persistence.hasConflictingResult,
            }).verify(resources, { ...runtimeJob, expectedParentCommit: baseCommit }, process);
        verifierVerdicts.set(runtimeJob.attemptId, Object.freeze({
          status: verdict.status,
          commitSha: verdict.commitSha,
          failureCode: verdict.failureCode,
          checks: verdict.checks.map((check) => Object.freeze({ name: check.name, passed: check.passed })),
        }));
        return verdict;
      },
      persistResult: async (result) => {
        await persistence.recordResult({
          attemptId: result.attemptId,
          resultId: result.resultId,
          nodeId: jobs.find((j) => j.attemptId === result.attemptId)?.nodeId ?? 'multi-worker-pool-proof',
          selectedModel: options.model,
          status: result.status,
          commitSha: result.commitSha,
          failureCode: result.failureCode,
          checks: result.checks,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
        });
      },
      slotCount: 2,
    });

    const startedAt = new Date();
    const submitResults = await Promise.all(jobs.map((j) => runtime.submit(j.job)));
    await runtime.shutdown();
    const finishedAt = new Date();

    const attemptReports: Stage2AttemptReport[] = [];
    const persistedFacts = new Map<string, PersistedResultFact>();
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      const submitResult = submitResults[i];
      if (!submitResult) {
        return { ok: false, reason: `missing submit result for ${job.attemptId}`, failureCode: 'SUBMIT_RESULT_MISSING', attempt_diagnostics: attemptDiagnostics };
      }
      const persisted = await persistence.getResult(job.attemptId);
      const checks = persisted ? (await persistence.getChecks(job.attemptId)).map((c: ProofCheckRecord) => ({ name: c.check_name, passed: c.passed === 1 })) : [];
      if (persisted) persistedFacts.set(job.attemptId, Object.freeze({
        result_id: persisted.result_id,
        status: persisted.status,
        commit_sha: persisted.commit_sha,
        failure_code: persisted.failure_code,
        checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
      }));
      const resources = attemptResources.get(job.attemptId);
      attemptReports.push({
        attempt_id: job.attemptId,
        node_id: job.nodeId,
        slot_index: submitResult.slotIndex ?? 0,
        status: submitResult.ok && submitResult.status === 'passed' ? 'passed' : 'failed',
        builder_model: options.model,
        commit_sha: persisted?.commit_sha ?? null,
        failure_code: persisted?.failure_code ?? null,
        verifier_checks: checks,
        // Filled only after all raw observations pass aggregate validation.
        isolation: undefined as unknown as Stage2AttemptReport['isolation'],
      });
      const cleanupDisp = submitResult.cleanupDisposition;
      attemptDiagnostics.push({
        attempt_id: job.attemptId,
        slot_index: submitResult.slotIndex ?? 0,
        submit_ok: submitResult.ok,
        submit_status: submitResult.ok ? submitResult.status : null,
        submit_error: submitResult.ok ? null : submitResult.error,
        error_detail: redactAndCap(!submitResult.ok ? submitResult.errorDetail : undefined),
        persisted_status: persisted?.status ?? null,
        persisted_failure_code: persisted?.failure_code ?? null,
        persisted_result_present: persisted !== null,
        verifier_checks: checks.slice(0, 32),
        launcher_injected_fault: job.attemptId === options.injectFaultAttemptId,
        cleanup_workspace_removed: cleanupDisp?.workspaceRemoved ?? false,
        cleanup_attempt_root_removed: cleanupDisp?.attemptRootRemoved ?? false,
        cleanup_error_count: cleanupDisp?.errors.length ?? 0,
        process: processDiagnostics.get(job.attemptId) ?? null,
      });
    }

    const passed = attemptReports.filter((a) => a.status === 'passed');
    const failed = attemptReports.filter((a) => a.status === 'failed');
    if (passed.length !== 2 || failed.length !== 1) {
      await cleanup();
      return { ok: false, reason: `expected 2 passed and 1 failed, got ${passed.length} passed and ${failed.length} failed`, failureCode: 'STAGE2_OUTCOME_MISMATCH', attempt_diagnostics: attemptDiagnostics };
    }
    if (!failed.some((a) => a.failure_code === 'INJECTED_WORKER_FAILURE')) {
      await cleanup();
      return { ok: false, reason: 'injected failure not recorded as INJECTED_WORKER_FAILURE', failureCode: 'STAGE2_INJECTED_FAILURE_MISSING', attempt_diagnostics: attemptDiagnostics };
    }

    const rawObservations: RawStage2Observation[] = [];
    for (const job of jobs) {
      rawObservations.push(rawObservationFor(attemptResources.get(job.attemptId), job, verifierVerdicts.get(job.attemptId), persistedFacts.get(job.attemptId) ?? null, launchedProcesses.get(job.attemptId), hasFake));
    }
    const observationsToValidate = options.mutateRawObservationsForTest ? options.mutateRawObservationsForTest(rawObservations) : rawObservations;
    try {
      validateRawObservations(observationsToValidate);
    } catch (e) {
      await cleanup();
      return { ok: false, reason: e instanceof Error ? e.message : String(e), failureCode: 'STAGE2_ISOLATION_INVALID', attempt_diagnostics: attemptDiagnostics };
    }
    const rawByAttempt = new Map(observationsToValidate.map((raw) => [raw.attemptId, raw]));
    for (let index = 0; index < attemptReports.length; index += 1) {
      const attempt = attemptReports[index]!;
      const commitments = deriveCommitments(rawByAttempt.get(attempt.attempt_id)!);
      const isolation = { ...commitments, attempt_binding_hash: '' };
      attemptReports[index] = { ...attempt, isolation: { ...isolation, attempt_binding_hash: attemptBindingHash({ ...attempt, isolation }) } };
    }

    const workResults = await persistence.getResultsForWork(work.work_id);
    const routing = await persistence.getBuilderRoutingsForWork(work.work_id);
    const phaseArtifacts = await persistence.countPhaseArtifactsForWork(work.work_id);
    if (phaseArtifacts !== 0) {
      await cleanup();
      return { ok: false, reason: 'Stage 2 work contains unexpected phase-artifact provenance', failureCode: 'STAGE2_PHASE_ARTIFACT_PRESENT', attempt_diagnostics: attemptDiagnostics };
    }
    if (routing.length !== 3 || routing.some((r) => r.builder_model !== options.model)) {
      await cleanup();
      return { ok: false, reason: 'SQLite builder routing does not match three attempts with the selected model', failureCode: 'STAGE2_ROUTING_MISMATCH', attempt_diagnostics: attemptDiagnostics };
    }
    if (workResults.length !== 3) {
      await cleanup();
      return { ok: false, reason: `SQLite contains ${workResults.length} results, expected 3`, failureCode: 'STAGE2_SQLITE_RESULT_COUNT_MISMATCH', attempt_diagnostics: attemptDiagnostics };
    }

    // Collect every attempt's actual cleanup disposition from the runner-owned
    // submit results. Build and retain a passing report only after cleanup
    // succeeds; never hard-code cleanup truth.
    const attemptCleanups = submitResults.map((r) => r.cleanupDisposition).filter((d): d is { attemptRootRemoved: boolean; workspaceRemoved: boolean; brokerSocketRemoved?: boolean; errors: readonly string[] } => d !== undefined);
    const cleanupResult = await cleanup();
    const cleanupErrors = [...cleanupResult.errors, ...attemptCleanups.flatMap((d) => d.errors)];
    if (cleanupErrors.length > 0) {
      return { ok: false, reason: `cleanup failed: ${cleanupErrors.join('; ')}`, failureCode: 'STAGE2_CLEANUP_FAILED', attempt_diagnostics: attemptDiagnostics };
    }
    const workspaceRemoved = attemptCleanups.every((d) => d.workspaceRemoved) && cleanupResult.runtimeRootRemoved && cleanupResult.fixtureCloneRootRemoved;
    // Every Stage 2 attempt owns a launcher-allocated broker socket directory
    // outside the runtime root, so its removal must be verified alongside the
    // attempt root and store close before a passing report is retained.
    const brokerSocketsRemoved = attemptCleanups.every((d) => d.brokerSocketRemoved === true);
    const sessionRemoved = attemptCleanups.every((d) => d.attemptRootRemoved) && brokerSocketsRemoved && cleanupResult.storeClosed;

    const timingPoints = [
      { label: 'started', timestamp: startedAt },
      { label: 'finished', timestamp: finishedAt },
    ];

    const report = buildStage2Report({
      stage1Provenance: {
        // Retained evidence uses a repository-relative locator, never a host path.
        report_path: 'reports/stage-1-proof-report.json',
        report_sha256: gate.sha256,
        model: stage1.model,
        base_commit: stage1.base_commit,
        result_commit: stage1.result_commit ?? '',
      },
      attempts: attemptReports,
      timingPoints,
      cleanupDisposition: { workspaceRemoved, sessionRemoved },
      startedAt,
      finishedAt,
    });

    const validated = validateStage2Report(report);
    if (!validated.ok) {
      await cleanup();
      return { ok: false, reason: `Stage 2 report validation failed: ${validated.error}`, failureCode: 'STAGE2_REPORT_VALIDATION_FAILED', attempt_diagnostics: attemptDiagnostics };
    }

    await cleanup();
    return { ok: true, report, stage1Sha256: gate.sha256 };
  } catch (e) {
    await cleanup();
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason, failureCode: 'RUNTIME_EXCEPTION', attempt_diagnostics: attemptDiagnostics };
  } finally {
    await cleanup();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const piFlag = args.indexOf('--pi');
  const modelFlag = args.indexOf('--model');
  const runtimeFlag = args.indexOf('--container-runtime');
  const imageFlag = args.indexOf('--sandbox-image');
  const faultFlag = args.indexOf('--inject-fault-attempt-id');
  const fixtureFlag = args.indexOf('--fixture-source');

  const piPath = piFlag >= 0 ? args[piFlag + 1] : undefined;
  const model = (modelFlag >= 0 ? args[modelFlag + 1] : 'moonshot/kimi-k2.7-code') as ApprovedModelId;
  const containerRuntime = (runtimeFlag >= 0 ? args[runtimeFlag + 1] : 'docker') as 'docker' | 'podman';
  const sandboxImage = imageFlag >= 0 ? args[imageFlag + 1] : undefined;
  const injectFaultAttemptId = faultFlag >= 0 ? args[faultFlag + 1] : 'multi-worker-pool-proof-attempt-b';

  // Validate and hash-bind the canonical retained Stage 1 report before any
  // side effect: no default fixture mkdtemp, stale report deletion, preflight,
  // container work, DB, clones, brokers, slots, or model work may precede the
  // gate.
  const stage1Gate = loadAndValidateStage1Report(stage1ReportPath);
  if (!stage1Gate.ok) {
    console.error(`Stage 1 gate failed: ${stage1Gate.reason}`);
    process.exit(1);
  }

  const fixtureSourcePath = fixtureFlag >= 0
    ? args[fixtureFlag + 1]
    : mkdtempSync(join(tmpdir(), 'pool-proof-stage2-fixture-'));

  if (!sandboxImage) {
    console.error('sandbox image digest/ID is required');
    process.exit(1);
  }

  // Delete any stale report before attempting this run.
  try {
    rmSync(stage2ReportPath, { force: true });
  } catch {
    // ignore
  }

  const preflight = await runPreflight({ piPath, model, containerRuntime, sandboxImage });
  if (!preflight.ok) {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(stage2FailurePath, JSON.stringify(preflight.failure, null, 2));
    console.error(`preflight failed: ${preflight.failure.stage} - ${preflight.failure.reason}`);
    process.exit(1);
  }

  const result = await runStage2({
    stage1ReportPath,
    stage2ReportPath,
    preflight: preflight.result,
    model,
    containerRuntime,
    sandboxImage,
    adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
    injectFaultAttemptId,
    fixtureSourcePath,
  });

  if (!result.ok) {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(stage2FailurePath, JSON.stringify({ stage: 'stage2', reason: result.reason, failure_code: result.failureCode, attempt_diagnostics: result.attempt_diagnostics ?? [] }, null, 2));
    console.error(`Stage 2 proof failed: ${result.failureCode ?? 'UNKNOWN'} - ${result.reason}`);
    process.exit(1);
  }

  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(stage2ReportPath, JSON.stringify(result.report, null, 2));
  console.log(`Stage 2 proof passed: ${stage2ReportPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
