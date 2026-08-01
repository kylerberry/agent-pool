/**
 * Attempt workspace lifecycle and bounded cleanup (ADR-032).
 *
 * Workspace destruction is mandatory and bounded. A failed transcript extraction
 * marks the attempt `audit_incomplete` and alerts operations, but it must not
 * buy an untrusted workspace an indefinite stay of execution — that is exactly
 * the outcome ADR-032 rules out.
 *
 * So this state machine has no terminal "retain" decision. Cleanup is deferred
 * only while extraction is still resolving, and only until a quarantine deadline
 * fixed when the attempt starts. After the deadline the answer is `destroy`,
 * whatever the audit state, with the extraction-failure record preserved.
 */

import {
  createExecutionFailure,
  deepFreeze,
  type CleanupState,
  type ExecutionFailure,
} from './contracts.ts';

/** Default bounded quarantine for retry/diagnosis of a failed extraction. */
export const DEFAULT_QUARANTINE_MS = 15 * 60 * 1000;

/** Hard upper bound on quarantine; a caller cannot configure indefinite retention. */
export const MAX_QUARANTINE_MS = 60 * 60 * 1000;

export type CleanupDecision = {
  readonly decision: 'destroy' | 'wait';
  readonly state: CleanupState;
  readonly reason: string;
  /** Preserved when destroying an unsafe workspace whose audit never completed. */
  readonly auditIncomplete: boolean;
};

export interface AttemptWorkspaceLifecycle {
  readonly attemptId: string;
  state(): CleanupState;
  /** Move from `ready` into `extracting` when transcript retention begins. */
  beginExtraction(): CleanupState | ExecutionFailure;
  markAuditComplete(): CleanupState | ExecutionFailure;
  markAuditIncomplete(failureReason: string): CleanupState | ExecutionFailure;
  /** The recorded extraction-failure reason, preserved across destruction. */
  failureReason(): string | null;
  evaluateCleanup(now: number): CleanupDecision;
}

export function createAttemptWorkspaceLifecycle(init: {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly quarantineMs?: number;
}): AttemptWorkspaceLifecycle | ExecutionFailure {
  const quarantineMs = init.quarantineMs ?? DEFAULT_QUARANTINE_MS;
  if (!Number.isFinite(quarantineMs) || quarantineMs < 0 || quarantineMs > MAX_QUARANTINE_MS) {
    return createExecutionFailure('CLEANUP_BLOCKED_PENDING_EXTRACTION', 'quarantine bound is out of range');
  }
  const deadline = init.startedAt + quarantineMs;

  let state: CleanupState = 'ready';
  let reason: string | null = null;

  return Object.freeze({
    attemptId: init.attemptId,
    state: () => state,
    beginExtraction() {
      if (state !== 'ready') {
        return createExecutionFailure('TRANSCRIPT_STEP_OUT_OF_ORDER', `cannot begin extraction from ${state}`);
      }
      state = 'extracting';
      return state;
    },
    markAuditComplete() {
      if (state !== 'extracting') {
        return createExecutionFailure('TRANSCRIPT_STEP_OUT_OF_ORDER', `cannot complete audit from ${state}`);
      }
      state = 'audit_complete';
      return state;
    },
    markAuditIncomplete(failureReason: string) {
      if (state !== 'extracting') {
        return createExecutionFailure('TRANSCRIPT_STEP_OUT_OF_ORDER', `cannot fail audit from ${state}`);
      }
      state = 'audit_incomplete';
      reason = failureReason;
      return state;
    },
    failureReason: () => reason,
    evaluateCleanup(now: number): CleanupDecision {
      if (state === 'audit_complete') {
        return deepFreeze({
          decision: 'destroy' as const,
          state,
          reason: 'transcript extraction verified and indexed',
          auditIncomplete: false,
        });
      }
      if (now >= deadline) {
        // Bounded quarantine has expired. The workspace goes regardless of audit
        // state; the failure record survives it.
        return deepFreeze({
          decision: 'destroy' as const,
          state,
          reason: 'bounded quarantine expired; unsafe workspace must not persist',
          auditIncomplete: true,
        });
      }
      return deepFreeze({
        decision: 'wait' as const,
        state,
        reason:
          state === 'audit_incomplete'
            ? 'audit incomplete; within bounded quarantine for retry or diagnosis'
            : 'transcript extraction has not resolved yet',
        auditIncomplete: state === 'audit_incomplete',
      });
    },
  });
}
