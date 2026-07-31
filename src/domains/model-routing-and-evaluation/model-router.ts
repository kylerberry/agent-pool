/**
 * Fail-closed deterministic model router.
 *
 * All public outputs are constructed from validated, allowlisted facts.
 * Credentials, raw provider payloads, and arbitrary exception text never
 * enter RoutingDecision or typed RoutingFailure records.
 */

import {
  isApprovedModelId,
  parseModelId,
  type ApprovedModelId,
  type ModelId,
} from './approved-models.ts';
import type { AvailabilityEntryShape } from './contracts.ts';
import type { RoutingPolicy } from './routing-policy.ts';

export const PROJECTED_DECISION_FIELDS = Object.freeze([
  'role',
  'selectedModel',
  'rationale',
  'policyVersion',
  'fallbackBehavior',
]);

export const PROJECTED_FAILURE_FIELDS = Object.freeze(['code', 'role', 'requestedModel', 'reason']);

const FAILURE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  INVALID_AVAILABILITY: 'Availability snapshot must be an array',
  INVALID_AVAILABILITY_ENTRY: 'Availability entry must be an object',
  MISSING_AVAILABILITY_FULL_ID: 'Availability entry missing fullId string',
  UNAPPROVED_AVAILABILITY_ID: 'Availability entry is not an approved model',
  INCONSISTENT_AVAILABILITY_PROVIDER: 'Provider field does not match ID provider',
  INCONSISTENT_AVAILABILITY_MODEL: 'Model field does not match ID model',
  DUPLICATE_AVAILABILITY_ID: 'Duplicate availability entry',
  UNKNOWN_ROLE: 'Role has no routing configuration',
  UNAPPROVED_EXPLICIT_MODEL: 'Explicit model is not approved',
  UNAVAILABLE_EXPLICIT_MODEL: 'Explicit model is not available',
  NO_AVAILABLE_CANDIDATE: 'No available candidate for role',
  MISSING_PAIR_POLICY: 'Policy missing builder or evaluator role config',
  PAIR_CONSTRUCTION_FAILED: 'Failed to construct builder/evaluator decisions',
  NO_VALID_BUILDER_EVALUATOR_PAIR: 'No builder/evaluator pair satisfies policy constraints',
});

type SkippedCandidate = {
  readonly model: ModelId;
  readonly reason: string;
};

type RationaleEntry = {
  readonly code: string;
  readonly detail: string;
};

type FallbackBehavior = {
  readonly primaryAvailable: boolean;
  readonly selectedFallbackIndex: number | null;
  readonly skippedCandidates: readonly SkippedCandidate[];
};

export type RoutingDecision = {
  readonly role: string;
  readonly selectedModel: ModelId;
  readonly rationale: readonly RationaleEntry[];
  readonly policyVersion: number;
  readonly fallbackBehavior: FallbackBehavior;
  readonly toJSON: () => Record<string, unknown>;
};

export type RoutingFailure = {
  readonly code: string;
  readonly role?: string;
  readonly requestedModel?: string;
  readonly reason: string;
  readonly toJSON: () => Record<string, unknown>;
};

export type ValidatedAvailability = {
  readonly has: (modelId: ModelId) => boolean;
  readonly values: () => readonly ModelId[];
};

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function deepCopy<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepCopy(item)) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = deepCopy((value as Record<string, unknown>)[key]);
  }
  return copy as T;
}

function createRoutingFailure(
  code: string,
  role: string | undefined,
  requestedModel: string | undefined,
): RoutingFailure {
  const reason = FAILURE_REASONS[code] ?? 'Routing failure';
  const failure: RoutingFailure = Object.freeze({
    code,
    role,
    requestedModel,
    reason,
    toJSON(): Record<string, unknown> {
      const out: Record<string, unknown> = { code, reason };
      if (role !== undefined) out.role = role;
      if (requestedModel !== undefined) out.requestedModel = requestedModel;
      return deepCopy(out);
    },
  });
  return failure;
}

function createRoutingDecision(
  role: string,
  selectedModel: ModelId,
  policyVersion: number,
  rationale: readonly RationaleEntry[],
  fallbackBehavior: FallbackBehavior,
): RoutingDecision {
  const frozenRationale = deepFreeze([...rationale]);
  const frozenFallback = deepFreeze({ ...fallbackBehavior });
  const decision: RoutingDecision = Object.freeze({
    role,
    selectedModel,
    policyVersion,
    rationale: frozenRationale,
    fallbackBehavior: frozenFallback,
    toJSON(): Record<string, unknown> {
      return deepCopy({
        role,
        selectedModel,
        policyVersion,
        rationale: frozenRationale,
        fallbackBehavior: frozenFallback,
      });
    },
  });
  return decision;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateAvailability(input: unknown): ValidatedAvailability | RoutingFailure {
  if (!Array.isArray(input)) {
    return createRoutingFailure('INVALID_AVAILABILITY', undefined, undefined);
  }

  const seen = new Set<string>();
  const values: ApprovedModelId[] = [];

  for (const entry of input) {
    if (!isPlainObject(entry)) {
      return createRoutingFailure('INVALID_AVAILABILITY_ENTRY', undefined, undefined);
    }
    if (typeof entry.fullId !== 'string') {
      return createRoutingFailure('MISSING_AVAILABILITY_FULL_ID', undefined, undefined);
    }
    if (!isApprovedModelId(entry.fullId)) {
      return createRoutingFailure('UNAPPROVED_AVAILABILITY_ID', undefined, undefined);
    }
    if (entry.provider !== undefined && entry.provider !== entry.fullId.split('/')[0]) {
      return createRoutingFailure(
        'INCONSISTENT_AVAILABILITY_PROVIDER',
        undefined,
        entry.fullId,
      );
    }
    if (entry.model !== undefined && entry.model !== entry.fullId.split('/')[1]) {
      return createRoutingFailure(
        'INCONSISTENT_AVAILABILITY_MODEL',
        undefined,
        entry.fullId,
      );
    }
    if (seen.has(entry.fullId)) {
      return createRoutingFailure('DUPLICATE_AVAILABILITY_ID', undefined, entry.fullId);
    }
    seen.add(entry.fullId);
    values.push(entry.fullId);
  }

  return Object.freeze({
    has(modelId: ModelId): boolean {
      return seen.has(modelId);
    },
    values(): readonly ModelId[] {
      return Object.freeze([...values]);
    },
  });
}

export function isRoutingFailure(value: unknown): value is RoutingFailure {
  return isPlainObject(value) && typeof (value as RoutingFailure).code === 'string' && typeof (value as RoutingFailure).reason === 'string';
}

export function isRoutingDecision(value: unknown): value is RoutingDecision {
  return (
    isPlainObject(value) &&
    typeof (value as RoutingDecision).role === 'string' &&
    typeof (value as RoutingDecision).selectedModel === 'string' &&
    typeof (value as RoutingDecision).policyVersion === 'number'
  );
}

function pickCandidate(
  policy: RoutingPolicy,
  role: string,
  availability: ValidatedAvailability,
  explicitModelId?: string,
): { readonly selected: ModelId; readonly rationale: RationaleEntry[]; readonly fallback: FallbackBehavior } | RoutingFailure {
  const config = policy.getRoleConfig(role);
  if (!config) {
    return createRoutingFailure('UNKNOWN_ROLE', undefined, undefined);
  }

  const skipped: SkippedCandidate[] = [];

  if (explicitModelId !== undefined) {
    if (!isApprovedModelId(explicitModelId)) {
      return createRoutingFailure('UNAPPROVED_EXPLICIT_MODEL', undefined, undefined);
    }
    if (!availability.has(explicitModelId)) {
      return createRoutingFailure(
        'UNAVAILABLE_EXPLICIT_MODEL',
        role,
        explicitModelId,
      );
    }
    return {
      selected: explicitModelId,
      rationale: [{ code: 'explicit_model_selected', detail: 'Explicit candidate selected' }],
      fallback: { primaryAvailable: false, selectedFallbackIndex: null, skippedCandidates: [] },
    };
  }

  const candidates: ModelId[] = [config.primary, ...config.fallback];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (availability.has(candidate)) {
      return {
        selected: candidate,
        rationale: [
          {
            code: i === 0 ? 'primary_selected' : 'fallback_selected',
            detail: i === 0 ? 'Primary candidate selected' : 'Fallback candidate selected',
          },
        ],
        fallback: {
          primaryAvailable: i === 0,
          selectedFallbackIndex: i === 0 ? null : i - 1,
          skippedCandidates: Object.freeze([...skipped]),
        },
      };
    }
    skipped.push({ model: candidate, reason: 'unavailable' });
  }

  return createRoutingFailure('NO_AVAILABLE_CANDIDATE', role, undefined);
}

export function selectForRole(
  policy: RoutingPolicy,
  role: string,
  availability: ValidatedAvailability,
  explicitModelId?: string,
): RoutingDecision | RoutingFailure {
  const pick = pickCandidate(policy, role, availability, explicitModelId);
  if (isRoutingFailure(pick)) {
    return pick;
  }
  return createRoutingDecision(role, pick.selected, policy.version, pick.rationale, pick.fallback);
}

export function selectBuilderEvaluatorPair(
  policy: RoutingPolicy,
  availability: ValidatedAvailability,
  options: { explicitBuilder?: string; explicitEvaluator?: string } = {},
): { readonly builder: RoutingDecision; readonly evaluator: RoutingDecision } | RoutingFailure {
  const builderConfig = policy.getRoleConfig('building');
  const evaluatorConfig = policy.getRoleConfig('assessing');
  if (!builderConfig || !evaluatorConfig) {
    return createRoutingFailure('MISSING_PAIR_POLICY', undefined, undefined);
  }

  // These invariants are mandatory and unconditional; they cannot be disabled by policy rules.
  const mustDiffer = true;
  const mustNotDowngrade = true;

  const builderCandidates = [builderConfig.primary, ...builderConfig.fallback];
  const evaluatorCandidates = [evaluatorConfig.primary, ...evaluatorConfig.fallback];

  if (options.explicitBuilder !== undefined && !isApprovedModelId(options.explicitBuilder)) {
    return createRoutingFailure('UNAPPROVED_EXPLICIT_MODEL', 'building', undefined);
  }
  if (options.explicitEvaluator !== undefined && !isApprovedModelId(options.explicitEvaluator)) {
    return createRoutingFailure('UNAPPROVED_EXPLICIT_MODEL', 'assessing', undefined);
  }

  for (const builderId of builderCandidates) {
    if (!availability.has(builderId)) continue;
    if (options.explicitBuilder !== undefined && options.explicitBuilder !== builderId) continue;
    const effectiveBuilder = options.explicitBuilder ?? builderId;
    if (!isApprovedModelId(effectiveBuilder)) continue;
    if (!availability.has(effectiveBuilder)) continue;

    for (const evaluatorId of evaluatorCandidates) {
      if (!availability.has(evaluatorId)) continue;
      if (options.explicitEvaluator !== undefined && options.explicitEvaluator !== evaluatorId) continue;
      const effectiveEvaluator = options.explicitEvaluator ?? evaluatorId;
      if (!isApprovedModelId(effectiveEvaluator)) continue;
      if (!availability.has(effectiveEvaluator)) continue;

      if (mustDiffer && effectiveBuilder === effectiveEvaluator) continue;
      if (mustNotDowngrade && policy.getCapabilityRank(effectiveEvaluator) < policy.getCapabilityRank(effectiveBuilder)) {
        continue;
      }

      const builderDecision = selectForRole(policy, 'building', availability, effectiveBuilder);
      const evaluatorDecision = selectForRole(policy, 'assessing', availability, effectiveEvaluator);
      if (isRoutingFailure(builderDecision) || isRoutingFailure(evaluatorDecision)) {
        return createRoutingFailure('PAIR_CONSTRUCTION_FAILED', undefined, undefined);
      }
      return Object.freeze({ builder: builderDecision, evaluator: evaluatorDecision });
    }
  }

  return createRoutingFailure('NO_VALID_BUILDER_EVALUATOR_PAIR', undefined, undefined);
}
