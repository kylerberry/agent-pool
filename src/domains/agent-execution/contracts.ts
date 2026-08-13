/**
 * Dependency-free shared contracts for the Agent Execution domain.
 *
 * Everything here describes one attempt. Nothing in this domain models the DAG:
 * a worker is DAG-unaware by construction (ADR-010), so there is deliberately no
 * type for dependencies, siblings, or the ready frontier.
 */

export type CraftsPhase = 'C' | 'R' | 'A' | 'F' | 'T' | 'S';

/** Launcher-owned per-attempt execution marker (pool-worker-execution-context.schema.json v3). */
export type ExecutionContextShape = {
  readonly schema_version: 3;
  readonly actor: 'pool-worker';
  readonly node_id: string;
  readonly attempt_id: string;
  readonly attempt_nonce: string;
  readonly issued_by: 'agent-pool-supervisor' | 'agent-pool-runtime';
  readonly issued_at: string;
  readonly expires_at: string;
  readonly max_age_seconds: number;
  readonly target_repo: string;
  readonly target_branch: string;
  readonly workspace_path: string;
  readonly pi_runtime_parent: string;
  readonly pi_session_dir: string;
  readonly pi_executable_identity: {
    readonly path: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly package_identity: {
    readonly path: string;
    readonly profile: string;
    readonly digest: string;
  };
  readonly profile_identity: {
    readonly name: string;
    readonly path: string;
    readonly digest: string;
  };
  readonly selected_model: string;
  readonly tool_grants: readonly string[];
  readonly result_destination: {
    readonly kind: 'sqlite' | 'callback';
    readonly id: string;
  };
};

/** What the launcher independently asserts the attempt must be, out of band from the marker. */
export type LaunchExpectations = {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly workspacePath: string;
};

/** Extended launcher expectations for the Pool Proof vertical slice. */
export type PoolProofLaunchExpectations = LaunchExpectations & {
  readonly piRuntimeParent: string;
  readonly piSessionDir: string;
  readonly piExecutablePath: string;
  readonly piExecutableVersion: string;
  readonly piExecutableDigest: string;
  readonly packagePath: string;
  readonly packageProfile: string;
  readonly packageDigest: string;
  readonly profileName: string;
  readonly profilePath: string;
  readonly profileDigest: string;
  readonly selectedModel: string;
  readonly toolGrants: readonly string[];
  readonly resultDestinationId: string;
};

export type AcceptanceCriterion = {
  readonly id: string;
  readonly text: string;
};

export type CriteriaOrigin = {
  readonly source: 'decomposition' | 'direct_task';
  readonly source_id: string;
};

export type PriorFailureContext = {
  readonly attempt_id: string;
  readonly phase: CraftsPhase;
  readonly attempted: readonly string[];
  readonly failure_reason: string;
  readonly discoveries: readonly string[];
  readonly dead_ends: readonly string[];
};

/** The single unit payload a worker executes (pool-worker-attempt-contract.schema.json v1). */
export type AttemptContractShape = {
  readonly schema_version: 1;
  readonly node_id: string;
  readonly attempt_id: string;
  readonly attempt_number: number;
  readonly intent: string;
  readonly change_spec: string;
  readonly acceptance_criteria: readonly AcceptanceCriterion[];
  readonly criteria_origin: CriteriaOrigin;
  readonly target_repo: string;
  readonly target_branch: string;
  readonly prior_failure_context: readonly PriorFailureContext[];
};

/**
 * A typed, credential-free rejection. Failures carry a stable code and a fixed
 * reason string; they never echo untrusted input back to the caller, because a
 * failure record is written to the audit trail and read by operators.
 */
export type ExecutionFailure = {
  readonly code: string;
  readonly reason: string;
  readonly detail?: string;
  readonly toJSON: () => Record<string, unknown>;
};

/** ADR-032 workspace cleanup states. */
export type CleanupState = 'ready' | 'extracting' | 'audit_complete' | 'audit_incomplete';

export type TranscriptRetentionStep =
  | 'finalize'
  | 'redact'
  | 'hash'
  | 'persist'
  | 'verify'
  | 'index';

export function isExecutionFailure(value: unknown): value is ExecutionFailure {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as ExecutionFailure).code === 'string' &&
    typeof (value as ExecutionFailure).reason === 'string'
  );
}

export function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const FAILURE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  // Execution context
  CONTEXT_NOT_AN_OBJECT: 'Execution context must be an object',
  CONTEXT_UNKNOWN_FIELD: 'Execution context contains an unknown field',
  CONTEXT_MISSING_FIELD: 'Execution context is missing a required field',
  CONTEXT_INVALID_FIELD: 'Execution context field failed validation',
  CONTEXT_VERSION_UNSUPPORTED: 'Execution context schema version is not supported',
  CONTEXT_UNTRUSTED_ISSUER: 'Execution context was not issued by the supervisor',
  CONTEXT_IDENTITY_MISMATCH: 'Execution context identity does not match launcher expectations',
  CONTEXT_TARGET_MISMATCH: 'Execution context target does not match launcher expectations',
  CONTEXT_WORKSPACE_MISMATCH: 'Execution context workspace does not match launcher expectations',
  CONTEXT_FRESHNESS_CEILING_EXCEEDED: 'Execution context freshness budget exceeds the specification ceiling',
  CONTEXT_EXPIRY_INCOHERENT: 'Execution context expiry is not coherent with its issue time and budget',
  CONTEXT_NOT_YET_VALID: 'Execution context is issued too far in the future',
  CONTEXT_STALE: 'Execution context is stale',
  CONTEXT_REPLAYED: 'Execution context nonce has already been consumed',
  CONTEXT_CARRIES_DAG_TOPOLOGY: 'Execution context must not carry DAG topology',
  CONTEXT_PI_RUNTIME_MISMATCH: 'Execution context Pi runtime parent does not match launcher expectations',
  CONTEXT_PI_SESSION_MISMATCH: 'Execution context Pi session directory does not match launcher expectations',
  CONTEXT_PI_EXECUTABLE_MISMATCH: 'Execution context Pi executable identity does not match launcher expectations',
  CONTEXT_PACKAGE_MISMATCH: 'Execution context Worker package identity does not match launcher expectations',
  CONTEXT_PROFILE_MISMATCH: 'Execution context Worker profile identity does not match launcher expectations',
  CONTEXT_MODEL_MISMATCH: 'Execution context selected model does not match launcher expectations',
  CONTEXT_TOOL_GRANT_MISMATCH: 'Execution context tool grants do not match launcher expectations',
  CONTEXT_RESULT_DESTINATION_MISMATCH: 'Execution context result destination does not match launcher expectations',

  // Attempt contract
  CONTRACT_NOT_AN_OBJECT: 'Attempt contract must be an object',
  CONTRACT_UNKNOWN_FIELD: 'Attempt contract contains an unknown field',
  CONTRACT_MISSING_FIELD: 'Attempt contract is missing a required field',
  CONTRACT_INVALID_FIELD: 'Attempt contract field failed validation',
  CONTRACT_VERSION_UNSUPPORTED: 'Attempt contract schema version is not supported',
  CONTRACT_IDENTITY_MISMATCH: 'Attempt contract identity does not match the execution context',
  CONTRACT_TARGET_MISMATCH: 'Attempt contract target does not match the execution context',
  CONTRACT_CARRIES_DAG_TOPOLOGY: 'Attempt contract must not carry DAG topology',
  CONTRACT_NOT_EXACTLY_ONE: 'Exactly one attempt contract must be supplied',

  // Capabilities
  UNKNOWN_PHASE: 'Unknown CRAFTS phase',
  CAPABILITY_DENIED: 'Phase does not hold the requested capability',
  WRITE_PATH_OUT_OF_SCOPE: 'Write target is outside the phase write scope',

  // Backend fallback
  FALLBACK_MODEL_UNAPPROVED: 'Fallback model is outside the approved scope',
  FALLBACK_ATTEMPT_MISMATCH: 'Fallback must remain within the same attempt',
  FALLBACK_CHAIN_EXHAUSTED: 'Backend fallback chain is exhausted',
  FALLBACK_CHAIN_LIMIT: 'Backend fallback chain exceeds the per-attempt limit',
  FALLBACK_LEDGER_SEALED: 'Backend fallback ledger is already sealed',
  FALLBACK_COST_INVALID: 'Consumed cost must be a non-negative finite number',
  FALLBACK_OUTCOME_INVALID: 'Fallback outcome must be succeeded or failed',

  // Transcript retention and cleanup
  TRANSCRIPT_STEP_OUT_OF_ORDER: 'Transcript retention steps must run in the specified order',
  TRANSCRIPT_NOT_REDACTED: 'Transcript must be redacted before it is hashed and persisted',
  TRANSCRIPT_PERSIST_FAILED: 'Durable transcript persistence failed',
  TRANSCRIPT_VERIFY_FAILED: 'Durable transcript object failed verification',
  TRANSCRIPT_INDEX_FAILED: 'Transcript audit index commit failed',
  TRANSCRIPT_PATH_NOT_WORKSPACE_RELATIVE: 'transcript_path must be a workspace-relative locator',
  CLEANUP_BLOCKED_PENDING_EXTRACTION: 'Workspace cleanup is blocked until transcript extraction resolves',

  // Pool Proof
  POOL_PROOF_MODEL_UNAPPROVED: 'Selected builder model is not in the approved registry',
  POOL_PROOF_LAUNCHER_MISMATCH: 'Launcher expectation binding failed',
  POOL_PROOF_FAKE_ADAPTER_REJECTED: 'Production proof entry point rejected a fake adapter'
});

export function createExecutionFailure(code: string, detail?: string): ExecutionFailure {
  const reason = FAILURE_REASONS[code] ?? 'Agent execution failure';
  return Object.freeze({
    code,
    reason,
    detail,
    toJSON(): Record<string, unknown> {
      return detail === undefined ? { code, reason } : { code, reason, detail };
    },
  });
}
