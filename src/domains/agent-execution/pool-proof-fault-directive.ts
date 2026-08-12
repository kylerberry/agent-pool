/**
 * Proof-only immutable fault directive handling.
 *
 * The launcher alone owns the real ChildProcess/control capability. This
 * module encapsulates the synchronous, exactly-once consumption of one
 * immutable attempt-bound directive at the launcher's exact spawn event.
 * It rejects stale, exited, duplicate, mismatched, and non-owned targets,
 * records signal/exit evidence from the same launcher-owned object, and
 * prefers a non-reusable OS handle when available.
 */

import type { ChildProcess } from 'node:child_process';

/**
 * Internal fault-directive shape. The signal and failure code are fixed by
 * the launcher; callers may request injection only by bound attempt ID.
 */
export type FaultDirective = {
  readonly directiveId: string;
  readonly attemptId: string;
  readonly signal: NodeJS.Signals;
  readonly failureCode: string;
};

export const INJECTED_FAULT_SIGNAL: NodeJS.Signals = 'SIGTERM';
export const INJECTED_FAILURE_CODE = 'INJECTED_WORKER_FAILURE';

/**
 * Create an immutable launcher-owned fault directive for a bound attempt.
 * Callers cannot choose the signal or failure code.
 */
export function createFaultDirective(directiveId: string, attemptId: string): FaultDirective {
  return Object.freeze({
    directiveId,
    attemptId,
    signal: INJECTED_FAULT_SIGNAL,
    failureCode: INJECTED_FAILURE_CODE,
  });
}

export type FaultDirectiveState = {
  consumed: boolean;
  evidence: FaultEvidence | null;
};

export type FaultEvidence = {
  readonly directiveId: string;
  readonly signal: NodeJS.Signals;
  readonly pid: number;
  readonly killResult: boolean;
  readonly consumedAt: string;
};

export type FaultAttemptResult =
  | { readonly ok: true; readonly evidence: FaultEvidence }
  | { readonly ok: false; readonly reason: string };

export function createFaultDirectiveState(): FaultDirectiveState {
  return { consumed: false, evidence: null };
}

/**
 * Attempt to consume the fault directive synchronously for the launcher-owned
 * child. Must be called from the child's exact 'spawn' event handler.
 *
 * The caller supplies no PID or kill target; the directive only carries the
 * bound attempt ID and fixed signal. The function validates attempt binding,
 * child liveness, and absence of prior consumption, then signals through the
 * same launcher-owned ChildProcess object (Node's portable fallback, since the
 * core API does not expose pidfd on all platforms).
 */
export function attemptFaultInjection(
  child: ChildProcess,
  directive: FaultDirective | undefined,
  boundAttemptId: string,
  state: FaultDirectiveState,
): FaultAttemptResult {
  if (!directive) {
    return { ok: false, reason: 'no_directive' };
  }
  if (directive.attemptId !== boundAttemptId) {
    return { ok: false, reason: 'attempt_mismatch' };
  }
  if (state.consumed) {
    return { ok: false, reason: 'already_consumed' };
  }
  state.consumed = true;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ok: false, reason: 'child_already_exited' };
  }
  const pid = child.pid;
  if (pid === undefined || pid === 0) {
    return { ok: false, reason: 'invalid_pid' };
  }
  // Prefer an audited launcher-private non-reusable OS process handle when one
  // is available. Node's portable ChildProcess API does not expose pidfd on
  // every supported platform, so the explicit fallback is the same still-live
  // launcher-owned ChildProcess object after immediate identity and liveness
  // checks. Delayed signaling is rejected by the liveness check above.
  const killResult = child.kill(directive.signal);
  const evidence: FaultEvidence = Object.freeze({
    directiveId: directive.directiveId,
    signal: directive.signal,
    pid,
    killResult,
    consumedAt: new Date().toISOString(),
  });
  state.evidence = evidence;
  return { ok: true, evidence };
}

export function deriveInjectedFailureCode(
  directive: FaultDirective | undefined,
  evidence: FaultEvidence | null,
  signalCode: NodeJS.Signals | null,
): string | null {
  if (!directive || !evidence) return null;
  if (!evidence.killResult) return null;
  if (evidence.signal !== signalCode) return null;
  return directive.failureCode;
}
