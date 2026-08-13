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
import type { TranscriptAuditRecord } from './transcript-retention.ts';

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
  /**
   * Complete the audit. Requires the verified retention record, so the state
   * cannot be advanced by a caller that never ran the retention pipeline.
   */
  markAuditComplete(proof: TranscriptAuditRecord): CleanupState | ExecutionFailure;
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
  // A non-finite start time yields a NaN deadline, and every `now >= deadline`
  // comparison against NaN is false — which is indefinite retention wearing a
  // bounded-quarantine costume. Reject it at construction.
  if (!Number.isFinite(init.startedAt)) {
    return createExecutionFailure('CLEANUP_BLOCKED_PENDING_EXTRACTION', 'attempt start time is not finite');
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
    markAuditComplete(proof: TranscriptAuditRecord) {
      if (state !== 'extracting') {
        return createExecutionFailure('TRANSCRIPT_STEP_OUT_OF_ORDER', `cannot complete audit from ${state}`);
      }
      // Authorizing destruction is the point of no return for the transcript, so
      // it is bound to evidence that retention actually succeeded rather than to
      // a caller's assertion that it did.
      if (
        !proof ||
        proof.extraction_status !== 'audit_complete' ||
        proof.attempt_id !== init.attemptId ||
        typeof proof.transcript_object_id !== 'string' ||
        proof.transcript_object_id.trim() === '' ||
        proof.redaction_status !== 'redacted'
      ) {
        return createExecutionFailure(
          'CLEANUP_BLOCKED_PENDING_EXTRACTION',
          'audit completion requires a verified transcript retention record for this attempt',
        );
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
      if (!Number.isFinite(now)) {
        return deepFreeze({
          decision: 'destroy' as const,
          state,
          reason: 'cleanup clock is invalid; workspace must not persist',
          auditIncomplete: state !== 'audit_complete',
        });
      }
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
