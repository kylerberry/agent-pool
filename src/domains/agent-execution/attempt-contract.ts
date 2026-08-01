/**
 * Attempt-contract validation — the DAG-unaware unit boundary.
 *
 * A worker executes exactly one attempt contract. `validateAttemptContracts`
 * takes the whole delivered batch precisely so "exactly one" is enforceable:
 * a launcher that hands over two units, or none, fails closed rather than having
 * one silently picked for it.
 *
 * Acceptance criteria are immutable ground truth here. This module validates
 * their shape and provenance; it never rewrites, merges, or defaults them.
 */

import {
  createExecutionFailure,
  deepFreeze,
  isPlainObject,
  type AttemptContractShape,
  type CraftsPhase,
  type ExecutionFailure,
} from './contracts.ts';
import { findDagTopology } from './dag-exclusion.ts';

export const SUPPORTED_CONTRACT_SCHEMA_VERSION = 1;

const REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'node_id',
  'attempt_id',
  'attempt_number',
  'intent',
  'change_spec',
  'acceptance_criteria',
  'criteria_origin',
  'target_repo',
  'target_branch',
  'prior_failure_context',
]);

const REQUIRED_FIELD_SET = new Set<string>(REQUIRED_FIELDS);
const CRITERIA_SOURCES = new Set(['decomposition', 'direct-task']);
const PHASES = new Set<CraftsPhase>(['C', 'R', 'A', 'F', 'T', 'S']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateCriteria(value: unknown): ExecutionFailure | null {
  if (!Array.isArray(value) || value.length === 0) {
    return createExecutionFailure('CONTRACT_INVALID_FIELD', 'acceptance_criteria');
  }
  const seen = new Set<string>();
  for (const criterion of value) {
    if (!isPlainObject(criterion)) {
      return createExecutionFailure('CONTRACT_INVALID_FIELD', 'acceptance_criteria');
    }
    const keys = Object.keys(criterion);
    if (keys.length !== 2 || !isNonEmptyString(criterion.id) || !isNonEmptyString(criterion.text)) {
      return createExecutionFailure('CONTRACT_INVALID_FIELD', 'acceptance_criteria');
    }
    if (seen.has(criterion.id)) {
      return createExecutionFailure('CONTRACT_INVALID_FIELD', 'acceptance_criteria');
    }
    seen.add(criterion.id);
  }
  return null;
}

function validatePriorFailureContext(value: unknown): ExecutionFailure | null {
  if (!Array.isArray(value)) {
    return createExecutionFailure('CONTRACT_INVALID_FIELD', 'prior_failure_context');
  }
  const allowed = new Set([
    'attempt_id',
    'phase',
    'attempted',
    'failure_reason',
    'discoveries',
    'dead_ends',
  ]);
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return createExecutionFailure('CONTRACT_INVALID_FIELD', 'prior_failure_context');
    }
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) return createExecutionFailure('CONTRACT_UNKNOWN_FIELD', `prior_failure_context.${key}`);
    }
    if (
      !isNonEmptyString(entry.attempt_id) ||
      !PHASES.has(entry.phase as CraftsPhase) ||
      !isStringArray(entry.attempted) ||
      typeof entry.failure_reason !== 'string' ||
      !isStringArray(entry.discoveries) ||
      !isStringArray(entry.dead_ends)
    ) {
      return createExecutionFailure('CONTRACT_INVALID_FIELD', 'prior_failure_context');
    }
  }
  return null;
}

export type ValidatedAttemptContract = {
  readonly contract: AttemptContractShape;
  readonly criteriaIds: readonly string[];
  readonly toJSON: () => Record<string, unknown>;
};

export type AttemptContractExpectations = {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
};

function validateOne(
  input: unknown,
  expectations: AttemptContractExpectations,
): ValidatedAttemptContract | ExecutionFailure {
  if (!isPlainObject(input)) return createExecutionFailure('CONTRACT_NOT_AN_OBJECT');

  for (const key of Object.keys(input)) {
    if (!REQUIRED_FIELD_SET.has(key)) return createExecutionFailure('CONTRACT_UNKNOWN_FIELD', key);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(input, key)) return createExecutionFailure('CONTRACT_MISSING_FIELD', key);
  }

  if (input.schema_version !== SUPPORTED_CONTRACT_SCHEMA_VERSION) {
    return createExecutionFailure('CONTRACT_VERSION_UNSUPPORTED');
  }
  for (const key of ['node_id', 'attempt_id', 'intent', 'change_spec', 'target_repo', 'target_branch'] as const) {
    if (!isNonEmptyString(input[key])) return createExecutionFailure('CONTRACT_INVALID_FIELD', key);
  }
  if (typeof input.attempt_number !== 'number' || !Number.isInteger(input.attempt_number) || input.attempt_number < 1) {
    return createExecutionFailure('CONTRACT_INVALID_FIELD', 'attempt_number');
  }

  const criteriaFailure = validateCriteria(input.acceptance_criteria);
  if (criteriaFailure) return criteriaFailure;

  const origin = input.criteria_origin;
  if (
    !isPlainObject(origin) ||
    Object.keys(origin).length !== 2 ||
    !CRITERIA_SOURCES.has(origin.source as string) ||
    !isNonEmptyString(origin.source_id)
  ) {
    return createExecutionFailure('CONTRACT_INVALID_FIELD', 'criteria_origin');
  }

  const priorFailure = validatePriorFailureContext(input.prior_failure_context);
  if (priorFailure) return priorFailure;

  const topology = findDagTopology(input, 'attempt-contract');
  if (topology !== null) return createExecutionFailure('CONTRACT_CARRIES_DAG_TOPOLOGY', topology);

  if (input.node_id !== expectations.nodeId || input.attempt_id !== expectations.attemptId) {
    return createExecutionFailure('CONTRACT_IDENTITY_MISMATCH');
  }
  if (input.target_repo !== expectations.targetRepo || input.target_branch !== expectations.targetBranch) {
    return createExecutionFailure('CONTRACT_TARGET_MISMATCH');
  }

  const contract = deepFreeze({ ...input }) as unknown as AttemptContractShape;
  return Object.freeze({
    contract,
    criteriaIds: Object.freeze(contract.acceptance_criteria.map((criterion) => criterion.id)),
    toJSON(): Record<string, unknown> {
      return { ...contract };
    },
  });
}

/**
 * Validate the delivered attempt-contract batch. Exactly one contract must be
 * present; zero or many is a launcher error, not a selection problem.
 */
export function validateAttemptContracts(
  inputs: unknown,
  expectations: AttemptContractExpectations,
): ValidatedAttemptContract | ExecutionFailure {
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    return createExecutionFailure('CONTRACT_NOT_EXACTLY_ONE');
  }
  return validateOne(inputs[0], expectations);
}
