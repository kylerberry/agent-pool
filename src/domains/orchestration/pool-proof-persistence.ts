/**
 * Minimal proof persistence for Pool Proof Stage 1.
 *
 * Composes the public OrchestrationStore API to import a direct work/node and
 * atomically create the attempt plus builder-routing provenance. Adds proof-
 * specific terminal result/check/timing records through the same public store
 * API.
 *
 * Does not write evaluator provenance or CRAFTS phase-artifact revisions.
 */

import type { ApprovedModelId } from '../model-routing-and-evaluation/approved-models.ts';
import type { OrchestrationStore } from './sqlite-store.ts';
import type { ApprovedWork, ResolvedBuilderRouting } from './contracts.ts';

export type ProofResultInput = {
  readonly attemptId: string;
  readonly resultId: string;
  readonly nodeId: string;
  readonly selectedModel: ApprovedModelId;
  readonly status: 'passed' | 'failed';
  readonly commitSha: string | null;
  readonly failureCode: string | null;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
};

export type ProofResultRecord = {
  readonly attempt_id: string;
  readonly result_id: string;
  readonly node_id: string;
  readonly builder_model: string;
  readonly status: 'passed' | 'failed';
  readonly commit_sha: string | null;
  readonly failure_code: string | null;
  readonly started_at: string;
  readonly finished_at: string;
};

export type ProofCheckRecord = {
  readonly attempt_id: string;
  readonly check_name: string;
  readonly passed: number;
};

export type PoolProofPersistence = {
  readonly ensureSchema: () => void;
  readonly importWorkAndCreateAttempt: (
    work: ApprovedWork,
    nodeId: string,
    attemptId: string,
    attemptNumber: number,
    jobId: string,
    builderRouting: ResolvedBuilderRouting,
  ) => Promise<void>;
  readonly recordResult: (input: ProofResultInput) => Promise<void>;
  readonly getResult: (attemptId: string) => Promise<ProofResultRecord | null>;
  readonly getChecks: (attemptId: string) => Promise<readonly ProofCheckRecord[]>;
  readonly countPhaseArtifactsForAttempt: (attemptId: string) => Promise<number>;
  readonly hasConflictingResult: (attemptId: string, resultId: string) => Promise<{ readonly hasConflict: boolean; readonly existingResultId: string | null }>;
};

export function createPoolProofPersistence(store: OrchestrationStore): PoolProofPersistence {
  return {
    ensureSchema(): void {
      // Schema is created by the OrchestrationStore migration pipeline; this
      // method remains for interface compatibility.
    },

    async importWorkAndCreateAttempt(
      work: ApprovedWork,
      nodeId: string,
      attemptId: string,
      attemptNumber: number,
      jobId: string,
      builderRouting: ResolvedBuilderRouting,
    ): Promise<void> {
      const imported = await store.importApprovedWork(work);
      if ('error' in imported) {
        throw new Error(`work import failed: ${imported.error.code} - ${imported.error.message}`);
      }
      const node = await store.getApprovedNode(work.work_id, nodeId);
      if (!node) {
        throw new Error(`node not found after import: ${nodeId}`);
      }
      const transitioned = await store.transitionNode(work.work_id, nodeId, 1, 'ready');
      if ('error' in transitioned) {
        throw new Error(`node transition failed: ${transitioned.error.code} - ${transitioned.error.message}`);
      }
      const attempt = await store.createAttempt(work.work_id, nodeId, attemptId, attemptNumber, jobId, builderRouting);
      if ('error' in attempt) {
        throw new Error(`attempt creation failed: ${attempt.error.code} - ${attempt.error.message}`);
      }
    },

    async recordResult(input: ProofResultInput): Promise<void> {
      const result = await store.recordProofResult({
        attempt_id: input.attemptId,
        result_id: input.resultId,
        node_id: input.nodeId,
        builder_model: input.selectedModel,
        status: input.status,
        commit_sha: input.commitSha,
        failure_code: input.failureCode,
        checks: input.checks,
        started_at: input.startedAt,
        finished_at: input.finishedAt,
      });
      if (!('ok' in result)) {
        throw new Error(`record proof result failed: ${result.error.code} - ${result.error.message}`);
      }
    },

    async getResult(attemptId: string): Promise<ProofResultRecord | null> {
      const row = await store.getProofResult(attemptId);
      if (!row) return null;
      return row as ProofResultRecord;
    },

    async getChecks(attemptId: string): Promise<readonly ProofCheckRecord[]> {
      return store.getProofChecks(attemptId);
    },

    async countPhaseArtifactsForAttempt(attemptId: string): Promise<number> {
      return store.countPhaseArtifactsForAttempt(attemptId);
    },

    async hasConflictingResult(attemptId: string, resultId: string): Promise<{ readonly hasConflict: boolean; readonly existingResultId: string | null }> {
      return store.hasConflictingProofResult(attemptId, resultId);
    },
  };
}
