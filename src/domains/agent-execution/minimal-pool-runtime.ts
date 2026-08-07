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
  | { readonly ok: true; readonly attemptId: string; readonly resultId: string; readonly status: 'passed' | 'failed'; readonly cleanupDisposition?: CleanupDisposition }
  | { readonly ok: false; readonly attemptId: string; readonly error: string; readonly errorDetail?: string; readonly cleanupDisposition?: CleanupDisposition };

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

export function createMinimalPoolRuntime(options: MinimalPoolRuntimeOptions): MinimalPoolRuntime {
  const queue: QueuedJob[] = [];
  let active = false;
  let shuttingDown = false;
  let drainedResolve: (() => void) | null = null;

  async function runOne(job: ProofJob): Promise<SubmitResult> {
    const startedAt = new Date();
    const resources = options.resourceFactory.allocate(job.attemptId, job.workspacePath);
    let process: PiProcess | undefined;
    let result: SubmitResult;
    let resultPersisted = false;

    async function persistFailed(
      failureCode: string,
      checks: readonly { readonly name: string; readonly passed: boolean }[],
    ): Promise<void> {
      if (resultPersisted) return;
      const finishedAt = new Date();
      await options.persistResult({
        attemptId: job.attemptId,
        resultId: resources.resultId,
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
        await persistFailed(failureCode, checks);
        result = { ok: false, attemptId: job.attemptId, error: failureCode };
      } else {
        process = launched;
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
        };
      }
    } catch (e) {
      const failureCode = 'RUNTIME_EXCEPTION';
      const checks = [{ name: 'runtime_exception', passed: false }];
      try {
        await persistFailed(failureCode, checks);
      } catch {
        // Persistence failure is bounded: the result record already exists or
        // the database is unreachable. The launch failure is still reported.
      }
      const errorDetail = e instanceof Error ? e.message : String(e);
      result = { ok: false, attemptId: job.attemptId, error: failureCode, errorDetail };
    } finally {
      if (process && process.exitCode === null) {
        try {
          process.kill('SIGTERM');
        } catch {}
      }
      const cleanupDisposition = options.resourceFactory.release(resources);
      Object.assign(result!, { cleanupDisposition });
    }
    return result!;
  }

  async function drain(): Promise<void> {
    while (true) {
      const queued = queue.shift();
      if (!queued) {
        active = false;
        if (drainedResolve) {
          drainedResolve();
          drainedResolve = null;
        }
        return;
      }
      const result = await runOne(queued.job);
      queued.resolve(result);
    }
  }

  return {
    async submit(job: ProofJob): Promise<SubmitResult> {
      if (shuttingDown) return { ok: false, attemptId: job.attemptId, error: 'runtime is shutting down' };
      if (hasFakeAdapter(options.adapterProvenance)) {
        return {
          ok: false,
          attemptId: job.attemptId,
          error: 'POOL_PROOF_FAKE_ADAPTER_REJECTED: production proof entry point rejected a fake adapter',
        };
      }

      return new Promise((resolve) => {
        queue.push({ job, resolve });
        if (!active) {
          active = true;
          drain();
        }
      });
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      if (active) {
        await new Promise<void>((resolve) => {
          drainedResolve = resolve;
        });
      }
    },
  };
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
