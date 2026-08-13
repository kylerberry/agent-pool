/**
 * Minimal Pool Runtime — Stage 1.
 *
 * Public boundary: process-local FIFO submission, one active attempt slot,
 * durable attempt/builder-routing/result persistence, fresh per-attempt
 * resources, launcher-verified Pi process spawn, and deterministic verifier
 * callback. Fake adapters are rejected by the production proof entry point.
 */

import type { ApprovedModelId } from '../model-routing-and-evaluation/approved-models.ts';
import type { AttemptResources, CleanupDisposition, ResourceFactory } from './attempt-resources.ts';
import type { ExecutionFailure, PoolProofLaunchExpectations } from './contracts.ts';
import { isExecutionFailure } from './contracts.ts';
import type { PiLauncher, PiProcess } from './pool-proof-pi-launcher.ts';
import type { GreenEvidence } from '../verification/pool-proof-verifier.ts';

export type ProofJob = {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly intent: string;
  readonly changeSpec: string;
  readonly acceptanceCriteria: readonly { readonly id: string; readonly text: string }[];
  readonly criteriaOriginSource: 'decomposition' | 'direct_task';
  readonly criteriaOriginSourceId: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly allowedChangedPaths: readonly string[];
  readonly fixtureTestCommand: readonly string[];
  /** Optional caller-supplied workspace path (e.g., an initialized fixture repository). */
  readonly workspacePath?: string;
};

export type SubmitResult =
  | { readonly ok: true; readonly attemptId: string; readonly resultId: string; readonly status: 'passed' | 'failed'; readonly slotIndex: number; readonly cleanupDisposition?: CleanupDisposition }
  | { readonly ok: false; readonly attemptId: string; readonly error: string; readonly errorDetail?: string; readonly slotIndex?: number; readonly cleanupDisposition?: CleanupDisposition };

export type AdapterProvenance = {
  readonly launcher: 'real' | 'fake';
  readonly sandbox: 'real' | 'fake';
  readonly verifier: 'real' | 'fake';
  readonly persistence: 'real' | 'fake';
};

export type MinimalPoolRuntimeOptions = {
  readonly resourceFactory: ResourceFactory;
  readonly createPiLauncher: (expectations: PoolProofLaunchExpectations, job: ProofJob) => PiLauncher;
  readonly selectedModel: ApprovedModelId;
  readonly launchIdentity: PoolProofLaunchExpectations;
  readonly persistAttempt: (attempt: {
    attemptId: string;
    nodeId: string;
    selectedModel: ApprovedModelId;
    resultId: string;
  }) => Promise<void>;
  readonly verify: (resources: AttemptResources, job: ProofJob, process: PiProcess) => Promise<{
    status: 'passed' | 'failed';
    commitSha: string | null;
    failureCode: string | null;
    checks: readonly { readonly name: string; readonly passed: boolean }[];
    greenEvidence: GreenEvidence | null;
  }>;
  readonly persistResult: (result: {
    attemptId: string;
    resultId: string;
    status: 'passed' | 'failed';
    commitSha: string | null;
    failureCode: string | null;
    checks: readonly { readonly name: string; readonly passed: boolean }[];
    greenEvidence: GreenEvidence | null;
    startedAt: Date;
    finishedAt: Date;
  }) => Promise<void>;
  /**
   * Explicit trusted adapter provenance. Production composition sets every
   * field to 'real'; tests may use 'fake' for individual adapters.
   */
  readonly adapterProvenance: AdapterProvenance;
  /**
   * Number of persistent ready capacity slots. Defaults to 1 for backwards
   * compatibility; Stage 2 sets this to 2.
   */
  readonly slotCount?: number;
};

export type MinimalPoolRuntime = {
  readonly submit: (job: ProofJob) => Promise<SubmitResult>;
  readonly shutdown: () => Promise<void>;
};

type QueuedJob = {
  readonly job: ProofJob;
  readonly resolve: (result: SubmitResult) => void;
};

function hasFakeAdapter(provenance: AdapterProvenance): boolean {
  return Object.values(provenance).some((v) => v === 'fake');
}

function validateSlotCount(value: unknown): number {
  const DEFAULT_SLOT_COUNT = 1;
  if (value === undefined || value === null) return DEFAULT_SLOT_COUNT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`POOL_PROOF_INVALID_SLOT_COUNT: slotCount must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function createMinimalPoolRuntimeWithPolicy(
  options: MinimalPoolRuntimeOptions,
  allowFakeAdapters: boolean,
): MinimalPoolRuntime {
  if (allowFakeAdapters && !hasFakeAdapter(options.adapterProvenance)) {
    throw new Error('POOL_PROOF_TEST_RUNTIME_REQUIRES_FAKE_ADAPTER: test-only runtime requires explicit fake adapter provenance');
  }

  const slotCount = validateSlotCount(options.slotCount);
  const queue: QueuedJob[] = [];
  const slots: { busy: boolean; attemptId: string | null }[] = Array.from(
    { length: slotCount },
    () => ({ busy: false, attemptId: null }),
  );
  const admitted = new Set<string>();
  let shuttingDown = false;
  let idleWaiters: (() => void)[] = [];

  function notifyWaiters(): void {
    const allIdle = slots.every((slot) => !slot.busy);
    if (queue.length === 0 && allIdle) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  }

  async function runOne(job: ProofJob, slotIndex: number): Promise<SubmitResult> {
    const startedAt = new Date();
    let resources: AttemptResources | undefined;
    let result: SubmitResult = { ok: false, attemptId: job.attemptId, error: 'UNINITIALIZED_RUNTIME_RESULT', slotIndex };
    let resultPersisted = false;

    async function persistFailed(
      failureCode: string,
      checks: readonly { readonly name: string; readonly passed: boolean }[],
      resultId: string,
    ): Promise<void> {
      if (resultPersisted) return;
      const finishedAt = new Date();
      await options.persistResult({
        attemptId: job.attemptId,
        resultId,
        status: 'failed',
        commitSha: null,
        failureCode,
        checks,
        greenEvidence: null,
        startedAt,
        finishedAt,
      });
      resultPersisted = true;
    }

    try {
      resources = options.resourceFactory.allocate(job.attemptId, job.workspacePath);
    } catch (e) {
      const errorDetail = e instanceof Error ? e.message : String(e);
      return { ok: false, attemptId: job.attemptId, error: 'RESOURCE_ALLOCATION_FAILED', errorDetail, slotIndex };
    }

    try {
      await options.persistAttempt({
        attemptId: job.attemptId,
        nodeId: job.nodeId,
        selectedModel: options.selectedModel,
        resultId: resources.resultId,
      });

      const expectations = buildExpectations(resources, job, options.selectedModel, options.launchIdentity);
      const marker = buildMarker(resources, job, options.selectedModel, expectations);
      const piLauncher = options.createPiLauncher(expectations, job);
      const launched = await piLauncher.launch(marker);
      if (isExecutionFailure(launched)) {
        const failureCode = launched.code;
        const checks = [{ name: 'launcher_binding', passed: false }];
        await persistFailed(failureCode, checks, resources.resultId);
        result = { ok: false, attemptId: job.attemptId, error: failureCode, slotIndex };
      } else {
        const process = launched;
        const verdict = await options.verify(resources, job, process);
        const finishedAt = new Date();
        await options.persistResult({
          attemptId: job.attemptId,
          resultId: resources.resultId,
          status: verdict.status,
          commitSha: verdict.commitSha,
          failureCode: verdict.failureCode,
          checks: verdict.checks,
          greenEvidence: verdict.greenEvidence,
          startedAt,
          finishedAt,
        });
        resultPersisted = true;
        result = {
          ok: true,
          attemptId: job.attemptId,
          resultId: resources.resultId,
          status: verdict.status,
          slotIndex,
        };
      }
    } catch (e) {
      const failureCode = 'RUNTIME_EXCEPTION';
      const checks = [{ name: 'runtime_exception', passed: false }];
      try {
        await persistFailed(failureCode, checks, resources.resultId);
      } catch {
        // Persistence failure is bounded: the result record may already exist
        // or the database is unreachable. The launch failure is still reported.
      }
      const errorDetail = e instanceof Error ? e.message : String(e);
      result = { ok: false, attemptId: job.attemptId, error: failureCode, errorDetail, slotIndex };
    } finally {
      let cleanupDisposition: CleanupDisposition;
      try {
        cleanupDisposition = options.resourceFactory.release(resources);
      } catch (e) {
        cleanupDisposition = {
          attemptRootRemoved: false,
          workspaceRemoved: false,
          errors: [e instanceof Error ? e.message : String(e)],
        };
      }
      result = { ...result, cleanupDisposition };
    }
    return result;
  }

  async function runSlot(slotIndex: number, slot: { busy: boolean; attemptId: string | null }, queued: QueuedJob): Promise<void> {
    try {
      const result = await runOne(queued.job, slotIndex);
      queued.resolve(result);
    } finally {
      // Retain admitted attempt IDs for the process-local runtime lifetime so
      // sequential duplicates cannot launch or persist again.
      slot.busy = false;
      slot.attemptId = null;
      notifyWaiters();
      schedule();
    }
  }

  function schedule(): void {
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!;
      if (!slot.busy) {
        const queued = queue.shift();
        if (!queued) break;
        slot.busy = true;
        slot.attemptId = queued.job.attemptId;
        void runSlot(i, slot, queued);
      }
    }
  }

  return {
    async submit(job: ProofJob): Promise<SubmitResult> {
      if (shuttingDown) {
        return { ok: false, attemptId: job.attemptId, error: 'POOL_PROOF_RUNTIME_SHUTTING_DOWN' };
      }
      if (hasFakeAdapter(options.adapterProvenance) && !allowFakeAdapters) {
        return {
          ok: false,
          attemptId: job.attemptId,
          error: 'POOL_PROOF_FAKE_ADAPTER_REJECTED: production proof entry point rejected a fake adapter',
        };
      }
      if (!hasFakeAdapter(options.adapterProvenance) && allowFakeAdapters) {
        return {
          ok: false,
          attemptId: job.attemptId,
          error: 'POOL_PROOF_TEST_RUNTIME_REQUIRES_FAKE_ADAPTER: test-only runtime requires explicit fake adapter provenance',
        };
      }
      if (admitted.has(job.attemptId)) {
        return { ok: false, attemptId: job.attemptId, error: 'POOL_PROOF_DUPLICATE_ATTEMPT_ID' };
      }

      admitted.add(job.attemptId);
      return new Promise((resolve) => {
        queue.push({ job, resolve });
        schedule();
      });
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      const allIdle = slots.every((slot) => !slot.busy);
      if (queue.length > 0 || !allIdle) {
        await new Promise<void>((resolve) => {
          idleWaiters.push(resolve);
        });
      }
    },
  };
}

export function createMinimalPoolRuntime(options: MinimalPoolRuntimeOptions): MinimalPoolRuntime {
  return createMinimalPoolRuntimeWithPolicy(options, false);
}

/**
 * Test-only runtime factory. It requires explicit fake adapter provenance and
 * must never be used by production pool-proof composition.
 */
export function createMinimalPoolRuntimeForTest(options: MinimalPoolRuntimeOptions): MinimalPoolRuntime {
  return createMinimalPoolRuntimeWithPolicy(options, true);
}

function buildExpectations(
  resources: AttemptResources,
  job: ProofJob,
  selectedModel: ApprovedModelId,
  launchIdentity: PoolProofLaunchExpectations,
): PoolProofLaunchExpectations {
  return {
    nodeId: job.nodeId,
    attemptId: job.attemptId,
    targetRepo: job.targetRepo,
    targetBranch: job.targetBranch,
    workspacePath: resources.workspacePath,
    piRuntimeParent: resources.piRuntimeParent,
    piSessionDir: resources.piSessionDir,
    piExecutablePath: launchIdentity.piExecutablePath,
    piExecutableVersion: launchIdentity.piExecutableVersion,
    piExecutableDigest: launchIdentity.piExecutableDigest,
    packagePath: launchIdentity.packagePath,
    packageProfile: launchIdentity.packageProfile,
    packageDigest: launchIdentity.packageDigest,
    profileName: launchIdentity.profileName,
    profilePath: launchIdentity.profilePath,
    profileDigest: launchIdentity.profileDigest,
    selectedModel,
    toolGrants: launchIdentity.toolGrants,
    resultDestinationId: resources.resultId,
  };
}

function buildMarker(
  resources: AttemptResources,
  job: ProofJob,
  selectedModel: ApprovedModelId,
  expectations: PoolProofLaunchExpectations,
): Record<string, unknown> {
  const issuedAt = new Date();
  return {
    schema_version: 3,
    actor: 'pool-worker',
    node_id: job.nodeId,
    attempt_id: job.attemptId,
    attempt_nonce: resources.nonce,
    issued_by: 'agent-pool-runtime',
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 180_000).toISOString(),
    max_age_seconds: 180,
    target_repo: job.targetRepo,
    target_branch: job.targetBranch,
    workspace_path: expectations.workspacePath,
    pi_runtime_parent: expectations.piRuntimeParent,
    pi_session_dir: expectations.piSessionDir,
    pi_executable_identity: {
      path: expectations.piExecutablePath,
      version: expectations.piExecutableVersion,
      digest: expectations.piExecutableDigest,
    },
    package_identity: {
      path: expectations.packagePath,
      profile: expectations.packageProfile,
      digest: expectations.packageDigest,
    },
    profile_identity: {
      name: expectations.profileName,
      path: expectations.profilePath,
      digest: expectations.profileDigest,
    },
    selected_model: selectedModel,
    tool_grants: expectations.toolGrants,
    result_destination: { kind: 'sqlite', id: expectations.resultDestinationId },
  };
}
