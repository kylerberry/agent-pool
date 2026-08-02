/**
 * Narrow public interface for the Work Intake domain.
 *
 * Decomposition and direct-task intake share this domain boundary. Direct-task
 * DAG topology remains intake-side and is never exposed as a worker contract.
 */

export type {
  DecompositionJob,
  DecompositionNode,
  DecompositionCandidate,
  DecompositionFailure,
  DecompositionInvocationRecord,
  BreadthRetriever,
  ModelInvocation,
  DecompositionModelInvoker,
} from './decomposition-contracts.ts';

export {
  isDecompositionCandidate,
  isDecompositionFailure,
} from './decomposition-contracts.ts';

export { runDecomposition } from './decomposition-harness.ts';

export type { DecompositionLimits } from './decomposition-limits.ts';
export { validateLimitPolicy, byteLength, loadLimitPolicyFromSource } from './decomposition-limits.ts';

export {
  sanitizePromptBoundValue,
  sanitizeStringArray,
  sanitizeOptionalString,
  projectProviderError,
  loadSanitizationPolicyFromSource,
} from './decomposition-sanitization.ts';

export type {
  AcceptedUnit,
  CriteriaProvenance,
  DirectTaskAcceptance,
  DirectTaskRejection,
  DirectTaskResult,
  DirectTaskSubmission,
  DirectTaskUnit,
  IntakeErrorCode,
  IntakeViolation,
} from './contracts.ts';

export { INTAKE_ERROR_CODES, INTAKE_LIMITS, UNIT_FIELDS, isAcceptance, isRejection } from './contracts.ts';

export type { DirectIntakeDependencies, DirectTaskRequest } from './direct-intake.ts';
export { acceptDirectTasks } from './direct-intake.ts';

export type { IdempotencyRecord, IdempotencyStore } from './idempotency.ts';
export {
  DEFAULT_MAX_IDEMPOTENCY_RECORDS,
  DIRECT_TASK_ROUTE,
  IdempotencyCapacityExceededError,
  InMemoryIdempotencyStore,
  idempotencyScopeKey,
  isValidIdempotencyKey,
} from './idempotency.ts';

export type { SubmissionValidation, ValidatedSubmission } from './unit-validation.ts';
export { findUnorderableUnits, validateSubmission } from './unit-validation.ts';

export type {
  AuthenticationResult,
  HttpAdapterDependencies,
  HttpRequest,
  HttpResponse,
} from './http-adapter.ts';
export { DIRECT_TASK_PATH, handleDirectTaskRequest, statusForViolations } from './http-adapter.ts';

export { canonicalize, hashPayload } from './payload-hash.ts';
