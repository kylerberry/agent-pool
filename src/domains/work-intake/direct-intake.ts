/**
 * The direct-task application boundary (ADR-028).
 *
 * `acceptDirectTasks` is deliberately **synchronous**: it cannot await a model
 * call, so "no decomposition occurs on this path" is a property of the type
 * signature rather than a convention. Its only collaborators are a caller
 * identity, an idempotency store, and a submission-id generator.
 */

import type {
  AcceptedUnit,
  CriteriaProvenance,
  DirectTaskAcceptance,
  DirectTaskResult,
  DirectTaskUnit,
  IntakeViolation,
} from './contracts.ts';
import type { IdempotencyStore } from './idempotency.ts';
import { DIRECT_TASK_ROUTE, idempotencyScopeKey, isValidIdempotencyKey } from './idempotency.ts';
import { hashPayload } from './payload-hash.ts';
import { validateSubmission } from './unit-validation.ts';

export type DirectTaskRequest = {
  /** Authenticated principal. Never read from the request body. */
  readonly callerId: string;
  readonly body: unknown;
  readonly idempotencyKey?: string | null;
};

export type DirectIntakeDependencies = {
  readonly store: IdempotencyStore;
  /** Injected so acceptance is deterministic under test. */
  readonly generateSubmissionId: () => string;
};

/** Recursively freeze so an accepted unit's criteria cannot drift after intake. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Attach provenance without touching the criteria themselves.
 *
 * The array is copied (so the caller's array cannot be mutated through us) but
 * each criterion string is carried across identically — no trimming, casing,
 * reordering, or renumbering. Preserving them exactly is what lets the CRAFTS
 * C phase treat them as ground truth.
 */
function acceptUnit(
  unit: DirectTaskUnit,
  provenanceBase: Omit<CriteriaProvenance, 'unit_id'>,
): AcceptedUnit {
  return deepFreeze({
    id: unit.id,
    intent: unit.intent,
    change_spec: unit.change_spec,
    acceptance_criteria: [...unit.acceptance_criteria],
    depends_on: [...(unit.depends_on ?? [])],
    acceptance_criteria_provenance: {
      ...provenanceBase,
      unit_id: unit.id,
    },
  });
}

function reject(violations: readonly IntakeViolation[]): DirectTaskResult {
  return deepFreeze({ rejected: true as const, violations });
}

/**
 * Accept one direct unit or one hand-authored flat DAG.
 *
 * Ordering matters and is deliberate: the idempotency key is validated, then
 * the payload is validated, and only then is the key's stored hash consulted.
 * A malformed body is therefore rejected on its own merits and never recorded,
 * so a caller can fix the body and retry under the same key.
 */
export function acceptDirectTasks(
  request: DirectTaskRequest,
  dependencies: DirectIntakeDependencies,
): DirectTaskResult {
  const { callerId, body } = request;
  const idempotencyKey = request.idempotencyKey ?? null;

  if (typeof callerId !== 'string' || callerId.trim().length === 0) {
    return reject([
      { code: 'UNAUTHENTICATED', path: '$', message: 'an authenticated caller id is required' },
    ]);
  }

  if (idempotencyKey !== null && !isValidIdempotencyKey(idempotencyKey)) {
    return reject([
      {
        code: 'INVALID_IDEMPOTENCY_KEY',
        path: 'Idempotency-Key',
        message: 'idempotency key must be non-empty printable ASCII without whitespace',
      },
    ]);
  }

  const validation = validateSubmission(body);
  if (!validation.ok) {
    return reject(validation.violations);
  }

  // Hash the normalized submission rather than the raw body, so that a retry
  // differing only in key order or absent-vs-undefined fields still replays,
  // while any semantic change conflicts.
  const normalized = {
    repo: validation.value.repo,
    branch: validation.value.branch,
    shape: validation.value.shape,
    units: validation.value.units.map((unit) => ({
      id: unit.id,
      intent: unit.intent,
      change_spec: unit.change_spec,
      acceptance_criteria: [...unit.acceptance_criteria],
      depends_on: [...(unit.depends_on ?? [])],
    })),
  };
  const payloadHash = hashPayload(normalized);

  const scopeKey =
    idempotencyKey === null ? null : idempotencyScopeKey(callerId, DIRECT_TASK_ROUTE, idempotencyKey);

  if (scopeKey !== null) {
    const existing = dependencies.store.get(scopeKey);
    if (existing !== undefined) {
      if (existing.payload_hash !== payloadHash) {
        return reject([
          {
            code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
            path: 'Idempotency-Key',
            message: 'this idempotency key was already used with a different payload',
          },
        ]);
      }
      // Same key, same payload: replay the original result verbatim.
      return deepFreeze({ ...existing.result, replayed: true });
    }
  }

  const provenanceBase: Omit<CriteriaProvenance, 'unit_id'> = {
    origin: 'direct_task',
    caller_id: callerId,
    submission_id: dependencies.generateSubmissionId(),
    idempotency_key: idempotencyKey,
  };

  const acceptance: DirectTaskAcceptance = deepFreeze({
    submission_id: provenanceBase.submission_id,
    repo: validation.value.repo,
    branch: validation.value.branch,
    units: validation.value.units.map((unit) => acceptUnit(unit, provenanceBase)),
    submission_shape: validation.value.shape,
    // Gate 1 is skipped because there is no decomposition to quarantine
    // (ADR-028). Gate 2 is structurally required and has no override.
    gate1_required: false as const,
    gate2_required: true as const,
    decomposition_invoked: false as const,
    payload_hash: payloadHash,
    replayed: false,
  });

  if (scopeKey !== null) {
    dependencies.store.put(scopeKey, { payload_hash: payloadHash, result: acceptance });
  }

  return acceptance;
}
