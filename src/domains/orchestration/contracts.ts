/**
 * Dependency-free shared contracts for the Orchestration domain.
 *
 * Owns DAG lifecycle, ready frontier, deterministic attempts, leases, and
 * result acceptance. Communicates with other domains through explicit ports
 * and contracts; no SQLite internals leak across boundaries.
 */

import type { AcceptedUnit } from '../work-intake/contracts.ts';

/** Canonical node lifecycle states. */
export type NodeState = 'pending' | 'ready' | 'in_progress' | 'passed' | 'failed';

/** Work origin distinguishes decomposed (Gate 1) from direct-task work. */
export type WorkOrigin = 'decomposition' | 'direct_task';

/** Immutable approved work as received from Work Intake. */
export type ApprovedWork = {
  readonly work_id: string;
  readonly origin: WorkOrigin;
  readonly repo: string;
  readonly branch: string;
  readonly payload_hash: string;
  readonly approval_id?: string;
  readonly approved_at?: string;
  readonly approved_head?: string;
  readonly nodes: readonly ApprovedNode[];
};

/** One node of approved work, carrying semantic dependency edges. */
export type ApprovedNode = {
  readonly id: string;
  readonly intent: string;
  readonly change_spec: string;
  readonly acceptance_criteria: readonly string[];
  readonly depends_on: readonly string[];
  readonly criteria_origin_source: 'decomposition' | 'direct_task';
  readonly criteria_origin_source_id: string;
};

/** Imported approved work with runtime identity. */
export type ImportedWork = {
  readonly work_id: string;
  readonly version: number;
};

/** Predicted-touch evidence supplied by Codebase Knowledge. */
export type PredictedTouchEvidence = {
  readonly evidence_id: string;
  readonly repo: string;
  readonly approved_head: string;
  readonly graph_revision: string;
  readonly manifest_digest: string;
  readonly algorithm_version: string;
  readonly policy_version: string;
  readonly gate1_approval_id: string;
  readonly classified_overlaps: readonly ClassifiedOverlap[];
};

export type ClassifiedOverlap = {
  readonly node_id: string;
  readonly confidence: number;
  readonly likely_touched_units: readonly string[];
  readonly shared_surfaces: readonly string[];
};

/** Injected versioned empirical scheduling policy. */
export type SchedulingPolicy = {
  readonly version: string;
  readonly classify: (ctx: {
    readonly nodeId: string;
    readonly overlaps: readonly ClassifiedOverlap[];
    readonly workNodeIds: readonly string[];
  }) =>
    | { readonly decision: 'serialize'; readonly blocker_node_id: string; readonly reason: string }
    | { readonly decision: 'optimistic'; readonly reason: string };
};

/** Policy output after provenance validation. */
export type SchedulingDecision =
  | { readonly decision: 'optimistic'; readonly reason: string }
  | { readonly decision: 'serialize'; readonly blocker_node_id: string; readonly reason: string };

export type PredictedTouchImport = {
  readonly evidence_id: string;
  readonly work_id: string;
  readonly decision: SchedulingDecision['decision'];
  readonly blocker_node_id: string | null;
  readonly reason: string;
};

/** Bounded identifier-only queue envelope. */
export type QueueEnvelope = {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly node_id: string;
  readonly work_id: string;
};

/** Lease command shapes from Agent Execution. */
export type LeaseCommand =
  | { readonly kind: 'claim'; readonly attempt_id: string; readonly owner: string }
  | { readonly kind: 'renew'; readonly attempt_id: string; readonly owner: string; readonly token: string }
  | { readonly kind: 'release'; readonly attempt_id: string; readonly owner: string; readonly token: string };

/** Worker result shape. */
export type WorkerResult = {
  readonly result_id: string;
  readonly attempt_id: string;
  readonly node_id: string;
  readonly work_id: string;
  readonly outcome: 'passed' | 'failed';
  readonly phase: string;
  readonly token: string;
  readonly generation: number;
  readonly expected_node_version: number;
  readonly artifact_path?: string;
  readonly summary?: string;
};

/** Ports. */
export type Clock = () => Date;

export type QueuePort = {
  readonly ensureJob: (envelope: QueueEnvelope) => Promise<void>;
  readonly removeJob: (jobId: string) => Promise<void>;
};

export type BackupHook = (sourcePath: string) => Promise<void>;

/** Error codes. */
export const ORCHESTRATION_ERROR_CODES = [
  'INVALID_WORK',
  'DUPLICATE_WORK',
  'CONFLICTING_WORK',
  'WORK_NOT_FOUND',
  'NODE_NOT_FOUND',
  'INVALID_TRANSITION',
  'STALE_VERSION',
  'INVALID_LEASE_COMMAND',
  'LEASE_CONFLICT',
  'LEASE_EXPIRED',
  'INVALID_RESULT',
  'STALE_RESULT',
  'RESULT_IDENTITY_MISMATCH',
  'RESULT_CONFLICT',
  'QUEUE_ENVELOPE_INVALID',
  'PREDICTED_TOUCH_INVALID',
  'DATABASE_PATH_UNSAFE',
  'MIGRATION_FAILED',
  'DATABASE_UNREACHABLE',
] as const;

export type OrchestrationErrorCode = (typeof ORCHESTRATION_ERROR_CODES)[number];

export type OrchestrationError = {
  readonly code: OrchestrationErrorCode;
  readonly message: string;
};

/** Centralized canonical bounds. */
export const ORCHESTRATION_LIMITS = {
  maxIdLength: 200,
  maxTextLength: 20_000,
  maxCriteriaPerNode: 100,
  maxNodes: 500,
  maxDependenciesPerNode: 500,
  maxRepoLength: 400,
  maxBranchLength: 400,
  maxEvidenceIdLength: 200,
  maxGraphRevisionLength: 400,
  maxDigestLength: 256,
  maxVersionLength: 100,
  maxOwnerLength: 200,
  maxTokenLength: 256,
  maxResultIdLength: 200,
  maxSummaryLength: 4_000,
  maxPathLength: 2_000,
  maxQueuePayloadDepth: 1,
  maxClassifiedOverlaps: 1_000,
  maxTouchedUnitsPerOverlap: 200,
  maxSharedSurfacesPerOverlap: 200,
} as const;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  // Accept ordinary records and null-prototype dictionaries; reject class
  // instances, Date, RegExp, and attacker-controlled prototype chains.
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown, max = Infinity): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function hasExactKeys(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every((k) => allowed.has(k));
}

/**
 * Default empirical scheduling policy factory.
 *
 * The threshold lives in the injected policy, not in Orchestration constants,
 * so it can be versioned and audited rather than hard-coded.
 */
export function makeEmpiricalSchedulingPolicy(options: {
  readonly version: string;
  readonly minConfidence: number;
}): SchedulingPolicy {
  return {
    version: options.version,
    classify(ctx) {
      const self = ctx.overlaps.find((o) => o.node_id === ctx.nodeId);
      if (!self) {
        return { decision: 'optimistic', reason: 'node not present in evidence' };
      }
      if (self.confidence < options.minConfidence) {
        return { decision: 'optimistic', reason: `confidence ${self.confidence} below policy threshold` };
      }
      if (self.likely_touched_units.length === 0 && self.shared_surfaces.length === 0) {
        return { decision: 'optimistic', reason: 'no touched units or shared surfaces' };
      }

      const selfUnits = new Set(self.likely_touched_units);
      const overlapsWith = ctx.overlaps.filter((other) => {
        if (other.node_id === ctx.nodeId) return false;
        if (other.confidence < options.minConfidence) return false;
        if (other.shared_surfaces.some((s) => self.shared_surfaces.includes(s))) return true;
        if (other.likely_touched_units.some((u) => selfUnits.has(u))) return true;
        return false;
      });

      if (overlapsWith.length === 0) {
        return { decision: 'optimistic', reason: 'no confident overlapping node' };
      }

      const sortedIds = [ctx.nodeId, ...overlapsWith.map((o) => o.node_id)].sort();
      const index = sortedIds.indexOf(ctx.nodeId);
      if (index === 0) {
        return { decision: 'optimistic', reason: 'deterministic winner among overlapping nodes' };
      }
      const blocker = sortedIds[index - 1]!;
      return {
        decision: 'serialize',
        blocker_node_id: blocker,
        reason: `deterministic serialization behind ${blocker}`,
      };
    },
  };
}

/** Strict bounded validator for identifier-only queue envelopes. */
export function validateQueueEnvelope(value: unknown): OrchestrationError | null {
  if (!isPlainObject(value)) {
    return { code: 'QUEUE_ENVELOPE_INVALID', message: 'envelope must be an object' };
  }
  const allowed = new Set(['job_id', 'attempt_id', 'node_id', 'work_id']);
  if (!hasExactKeys(value, allowed)) {
    return { code: 'QUEUE_ENVELOPE_INVALID', message: 'envelope contains unknown or missing fields' };
  }
  for (const key of ['job_id', 'attempt_id', 'node_id', 'work_id'] as const) {
    if (!isNonEmptyString(value[key], ORCHESTRATION_LIMITS.maxIdLength)) {
      return { code: 'QUEUE_ENVELOPE_INVALID', message: `invalid ${key}` };
    }
  }
  return null;
}

/** Strict bounded validator for lease commands. */
export function validateLeaseCommand(value: unknown): OrchestrationError | null {
  if (!isPlainObject(value)) {
    return { code: 'INVALID_LEASE_COMMAND', message: 'lease command must be an object' };
  }
  const kind = value.kind;
  if (kind !== 'claim' && kind !== 'renew' && kind !== 'release') {
    return { code: 'INVALID_LEASE_COMMAND', message: 'invalid kind' };
  }
  if (kind === 'claim') {
    const allowed = new Set(['kind', 'attempt_id', 'owner']);
    if (!hasExactKeys(value, allowed)) {
      return { code: 'INVALID_LEASE_COMMAND', message: 'claim contains unknown fields' };
    }
    if (!isNonEmptyString(value.attempt_id, ORCHESTRATION_LIMITS.maxIdLength)) {
      return { code: 'INVALID_LEASE_COMMAND', message: 'invalid attempt_id' };
    }
    if (!isNonEmptyString(value.owner, ORCHESTRATION_LIMITS.maxOwnerLength)) {
      return { code: 'INVALID_LEASE_COMMAND', message: 'invalid owner' };
    }
    return null;
  }
  const allowed = new Set(['kind', 'attempt_id', 'owner', 'token']);
  if (!hasExactKeys(value, allowed)) {
    return { code: 'INVALID_LEASE_COMMAND', message: `${kind} contains unknown fields` };
  }
  if (!isNonEmptyString(value.attempt_id, ORCHESTRATION_LIMITS.maxIdLength)) {
    return { code: 'INVALID_LEASE_COMMAND', message: 'invalid attempt_id' };
  }
  if (!isNonEmptyString(value.owner, ORCHESTRATION_LIMITS.maxOwnerLength)) {
    return { code: 'INVALID_LEASE_COMMAND', message: 'invalid owner' };
  }
  if (!isNonEmptyString(value.token, ORCHESTRATION_LIMITS.maxTokenLength)) {
    return { code: 'INVALID_LEASE_COMMAND', message: 'invalid token' };
  }
  return null;
}
