/**
 * Narrow public interface for the Work Intake domain.
 *
 * Only the direct-task path (ADR-028) is exposed here. DAG topology is an
 * intake-side concern: nothing in this surface is worker-facing, and worker
 * attempt contracts must not import it.
 */

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
  DIRECT_TASK_ROUTE,
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
