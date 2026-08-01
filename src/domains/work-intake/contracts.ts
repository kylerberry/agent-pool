/**
 * Dependency-free shared contracts for the Work Intake domain.
 *
 * These types describe the direct-task intake path (ADR-028): one unit or a
 * hand-authored flat DAG submitted through `POST /tasks`, bypassing model
 * decomposition and Gate 1. Gate 2 (PR review) is never bypassed.
 *
 * Nothing in this module imports a model adapter, a router, or any other
 * domain. The direct path is deterministic by construction.
 */

/** Per-node fields a unit may carry (ADR-018 emission schema). */
export const UNIT_FIELDS = ['id', 'intent', 'change_spec', 'acceptance_criteria', 'depends_on'] as const;

export type UnitField = (typeof UNIT_FIELDS)[number];

/** Envelope fields a submission may carry. */
export const SUBMISSION_FIELDS = ['repo', 'branch', 'unit', 'units'] as const;

export type SubmissionField = (typeof SUBMISSION_FIELDS)[number];

/**
 * A hand-authored work unit as submitted by a caller.
 *
 * Runtime state (`status`, `retry_count`, `budget_spent`, suite `path`/`hash`),
 * `required_role`, and `complexity` are deliberately absent: the controller and
 * the CRAFTS C phase own those respectively (ADR-018). Submitting them is an
 * unknown-field rejection, not a silently ignored extra.
 */
export type DirectTaskUnit = {
  readonly id: string;
  readonly intent: string;
  readonly change_spec: string;
  readonly acceptance_criteria: readonly string[];
  readonly depends_on?: readonly string[];
};

/**
 * The single application boundary for direct intake. Exactly one of `unit`
 * (one direct unit) or `units` (a flat DAG with `depends_on` edges) is present.
 */
export type DirectTaskSubmission = {
  readonly repo: string;
  readonly branch: string;
  readonly unit?: DirectTaskUnit;
  readonly units?: readonly DirectTaskUnit[];
};

/**
 * Criteria provenance carried on every accepted unit (orchestrator-spec §7.1).
 * `origin` is always `direct_task` on this path — the criteria came from the
 * caller, unchanged, and no decomposition model authored them.
 */
export type CriteriaProvenance = {
  readonly origin: 'direct_task';
  readonly caller_id: string;
  readonly submission_id: string;
  readonly unit_id: string;
  readonly idempotency_key: string | null;
};

/** A unit that passed validation, with provenance attached and criteria intact. */
export type AcceptedUnit = {
  readonly id: string;
  readonly intent: string;
  readonly change_spec: string;
  readonly acceptance_criteria: readonly string[];
  readonly depends_on: readonly string[];
  readonly acceptance_criteria_provenance: CriteriaProvenance;
};

/**
 * The result of a successful direct-task submission.
 *
 * `gate2_required` is structurally `true`: no caller input can clear it.
 * `decomposition_invoked` is structurally `false` and exists so downstream
 * consumers and tests can assert the no-model-call property directly.
 */
export type DirectTaskAcceptance = {
  readonly submission_id: string;
  readonly repo: string;
  readonly branch: string;
  readonly units: readonly AcceptedUnit[];
  readonly submission_shape: 'single_unit' | 'hand_authored_dag';
  readonly gate1_required: false;
  readonly gate2_required: true;
  readonly decomposition_invoked: false;
  readonly payload_hash: string;
  readonly replayed: boolean;
};

/** Deterministic, closed rejection vocabulary. */
export const INTAKE_ERROR_CODES = [
  'MALFORMED_BODY',
  'UNKNOWN_FIELD',
  'MISSING_FIELD',
  'INVALID_FIELD_TYPE',
  'INVALID_FIELD_FORMAT',
  'FIELD_TOO_LONG',
  'TOO_MANY_UNITS',
  'AMBIGUOUS_SUBMISSION_SHAPE',
  'EMPTY_SUBMISSION',
  'MISSING_ACCEPTANCE_CRITERIA',
  'DUPLICATE_UNIT_ID',
  'UNKNOWN_DEPENDENCY',
  'SELF_DEPENDENCY',
  'DUPLICATE_DEPENDENCY',
  'DEPENDENCY_CYCLE',
  'SINGLE_UNIT_HAS_DEPENDENCIES',
  'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
  'INVALID_IDEMPOTENCY_KEY',
  'UNAUTHENTICATED',
] as const;

export type IntakeErrorCode = (typeof INTAKE_ERROR_CODES)[number];

/** A single deterministic rejection. `path` is a stable JSON-pointer-ish locator. */
export type IntakeViolation = {
  readonly code: IntakeErrorCode;
  readonly path: string;
  readonly message: string;
  readonly unit_id?: string;
};

export type DirectTaskRejection = {
  readonly rejected: true;
  readonly violations: readonly IntakeViolation[];
};

export type DirectTaskResult = DirectTaskAcceptance | DirectTaskRejection;

export function isRejection(result: DirectTaskResult): result is DirectTaskRejection {
  return (result as DirectTaskRejection).rejected === true;
}

export function isAcceptance(result: DirectTaskResult): result is DirectTaskAcceptance {
  return (result as DirectTaskRejection).rejected !== true;
}

/**
 * Bounds on untrusted caller input. These are hard limits, not policy: they
 * cap memory and keep cycle detection linear on adversarial payloads.
 */
export const INTAKE_LIMITS = {
  maxUnits: 500,
  maxIdLength: 200,
  maxIntentLength: 2_000,
  maxChangeSpecLength: 20_000,
  maxCriterionLength: 4_000,
  maxCriteriaPerUnit: 100,
  maxDependenciesPerUnit: 500,
  maxRepoLength: 400,
  maxBranchLength: 400,
  maxIdempotencyKeyLength: 255,
} as const;
