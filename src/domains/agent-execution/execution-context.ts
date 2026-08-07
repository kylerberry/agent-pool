/**
 * Launcher-owned execution-context validation.
 *
 * Every attempt gets a context the launcher issued for that attempt alone. This
 * module is the fail-closed gate that binds an untrusted marker to the launcher's
 * independent expectations — node, attempt, repository, branch, workspace, private
 * Pi runtime/session roots, executable/package/profile identity, selected model,
 * tool grants, and result destination — before any paid work begins.
 *
 * Freshness is a marker field rather than a constant here so the launcher owns
 * the expectation. The five-minute ceiling from the orchestrator specification
 * still binds: a launcher may be stricter and never laxer.
 */

import {
  createExecutionFailure,
  deepFreeze,
  isExecutionFailure,
  isPlainObject,
  type ExecutionContextShape,
  type ExecutionFailure,
  type LaunchExpectations,
  type PoolProofLaunchExpectations,
} from './contracts.ts';
import { findDagTopology } from './dag-exclusion.ts';
import { isApprovedModelId } from '../model-routing-and-evaluation/approved-models.ts';

/** Absolute freshness ceiling fixed by `docs/raw/specs/orchestrator-spec.md` §2.1. */
export const FRESHNESS_CEILING_SECONDS = 300;

/** Tolerance for launcher/worker clock skew on a not-yet-valid marker. */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

export const SUPPORTED_CONTEXT_SCHEMA_VERSION = 3;

/** Upper bound on any marker string field, applied before pattern matching. */
export const MAX_FIELD_LENGTH = 4096;

const REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'actor',
  'node_id',
  'attempt_id',
  'attempt_nonce',
  'issued_by',
  'issued_at',
  'expires_at',
  'max_age_seconds',
  'target_repo',
  'target_branch',
  'workspace_path',
  'pi_runtime_parent',
  'pi_session_dir',
  'pi_executable_identity',
  'package_identity',
  'profile_identity',
  'selected_model',
  'tool_grants',
  'result_destination',
]);

const REQUIRED_FIELD_SET = new Set<string>(REQUIRED_FIELDS);

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const NONCE_PATTERN = /^[0-9a-f]{32,128}$/;
const ABSOLUTE_WORKSPACE_PATH = /^\/(?!.*(?:^|\/)\.\.(?:\/|$)).*[^/]$/;

/**
 * A record of nonces this host has already accepted. Replay detection is only as
 * strong as the store: an in-memory store protects one worker process, which is
 * the correct scope for a single-attempt worker, while cross-host replay
 * detection belongs to the supervisor that mints the nonce.
 */
export interface ConsumedNonceStore {
  has(nonce: string): boolean;
  add(nonce: string): void;
}

export function createInMemoryNonceStore(): ConsumedNonceStore {
  const consumed = new Set<string>();
  return {
    has: (nonce) => consumed.has(nonce),
    add: (nonce) => {
      consumed.add(nonce);
    },
  };
}

/** Parse a canonical UTC timestamp, rejecting impossible calendar dates such as 2026-02-30. */
function parseCanonicalUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = UTC_TIMESTAMP.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() !== month - 1 ||
    timestamp.getUTCDate() !== day ||
    timestamp.getUTCHours() !== hour ||
    timestamp.getUTCMinutes() !== minute ||
    timestamp.getUTCSeconds() !== second
  ) {
    return null;
  }
  return Date.parse(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && ABSOLUTE_WORKSPACE_PATH.test(value);
}

export type ValidatedExecutionContext = {
  readonly context: ExecutionContextShape;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly toJSON: () => Record<string, unknown>;
};

export type ValidateExecutionContextOptions = {
  readonly now?: number;
  readonly nonceStore?: ConsumedNonceStore;
  /** If provided, validate the extended Pool Proof binding fields. */
  readonly poolProofExpectations?: PoolProofLaunchExpectations;
};

function validateIdentityObject(
  input: unknown,
  requiredKeys: readonly string[],
  code: string,
): ExecutionFailure | Record<string, unknown> {
  if (!isPlainObject(input)) return createExecutionFailure(code);
  const required = new Set(requiredKeys);
  for (const key of Object.keys(input)) {
    if (!required.has(key)) return createExecutionFailure(code, key);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) return createExecutionFailure(code, key);
    if (!isNonEmptyString((input as Record<string, unknown>)[key])) return createExecutionFailure(code, key);
  }
  return input;
}

/**
 * Validate an untrusted execution-context marker against launcher expectations.
 *
 * On success the nonce is consumed, so a second call with the same marker and
 * the same store is rejected as a replay.
 */
export function validateExecutionContext(
  input: unknown,
  expectations: LaunchExpectations,
  options: ValidateExecutionContextOptions = {},
): ValidatedExecutionContext | ExecutionFailure {
  const now = options.now ?? Date.now();

  if (!isPlainObject(input)) return createExecutionFailure('CONTEXT_NOT_AN_OBJECT');

  // Bound field length before pattern matching. The workspace and timestamp
  // patterns use lookaheads whose cost grows with input size, and an untrusted
  // marker file has no inherent size limit.
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
      return createExecutionFailure('CONTEXT_INVALID_FIELD', key);
    }
  }

  if (input.schema_version !== SUPPORTED_CONTEXT_SCHEMA_VERSION) {
    return createExecutionFailure('CONTEXT_VERSION_UNSUPPORTED');
  }

  for (const key of Object.keys(input)) {
    if (!REQUIRED_FIELD_SET.has(key)) return createExecutionFailure('CONTEXT_UNKNOWN_FIELD', key);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(input, key)) return createExecutionFailure('CONTEXT_MISSING_FIELD', key);
  }
  if (input.actor !== 'pool-worker') return createExecutionFailure('CONTEXT_INVALID_FIELD', 'actor');
  if (input.issued_by !== 'agent-pool-supervisor' && input.issued_by !== 'agent-pool-runtime') {
    return createExecutionFailure('CONTEXT_UNTRUSTED_ISSUER');
  }

  for (const key of ['node_id', 'attempt_id', 'target_repo', 'target_branch'] as const) {
    if (!isNonEmptyString(input[key])) return createExecutionFailure('CONTEXT_INVALID_FIELD', key);
  }
  if (typeof input.attempt_nonce !== 'string' || !NONCE_PATTERN.test(input.attempt_nonce)) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'attempt_nonce');
  }
  if (!isAbsolutePath(input.workspace_path)) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'workspace_path');
  }
  if (!isAbsolutePath(input.pi_runtime_parent)) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'pi_runtime_parent');
  }
  if (!isAbsolutePath(input.pi_session_dir)) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'pi_session_dir');
  }
  if (
    typeof input.max_age_seconds !== 'number' ||
    !Number.isInteger(input.max_age_seconds) ||
    input.max_age_seconds < 1
  ) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'max_age_seconds');
  }
  if (input.max_age_seconds > FRESHNESS_CEILING_SECONDS) {
    return createExecutionFailure('CONTEXT_FRESHNESS_CEILING_EXCEEDED');
  }

  const piExecutable = validateIdentityObject(
    input.pi_executable_identity,
    ['path', 'version', 'digest'],
    'CONTEXT_INVALID_FIELD',
  );
  if (isExecutionFailure(piExecutable)) return piExecutable;

  const packageIdentity = validateIdentityObject(
    input.package_identity,
    ['path', 'profile', 'digest'],
    'CONTEXT_INVALID_FIELD',
  );
  if (isExecutionFailure(packageIdentity)) return packageIdentity;

  const profileIdentity = validateIdentityObject(
    input.profile_identity,
    ['name', 'path', 'digest'],
    'CONTEXT_INVALID_FIELD',
  );
  if (isExecutionFailure(profileIdentity)) return profileIdentity;

  if (!isNonEmptyString(input.selected_model)) return createExecutionFailure('CONTEXT_INVALID_FIELD', 'selected_model');
  if (!isApprovedModelId(input.selected_model)) {
    return createExecutionFailure('POOL_PROOF_MODEL_UNAPPROVED');
  }
  if (!isStringArray(input.tool_grants) || input.tool_grants.length === 0) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'tool_grants');
  }
  const resultDestination = validateResultDestination(input.result_destination);
  if (isExecutionFailure(resultDestination)) return resultDestination;

  const issuedAtMs = parseCanonicalUtc(input.issued_at);
  if (issuedAtMs === null) return createExecutionFailure('CONTEXT_INVALID_FIELD', 'issued_at');
  const expiresAtMs = parseCanonicalUtc(input.expires_at);
  if (expiresAtMs === null) return createExecutionFailure('CONTEXT_INVALID_FIELD', 'expires_at');

  // A launcher cannot buy extra life by widening expires_at past its own budget.
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > input.max_age_seconds * 1000) {
    return createExecutionFailure('CONTEXT_EXPIRY_INCOHERENT');
  }

  const topology = findDagTopology(input, 'execution-context');
  if (topology !== null) return createExecutionFailure('CONTEXT_CARRIES_DAG_TOPOLOGY', topology);

  if (input.node_id !== expectations.nodeId || input.attempt_id !== expectations.attemptId) {
    return createExecutionFailure('CONTEXT_IDENTITY_MISMATCH');
  }
  if (input.target_repo !== expectations.targetRepo || input.target_branch !== expectations.targetBranch) {
    return createExecutionFailure('CONTEXT_TARGET_MISMATCH');
  }
  if (input.workspace_path !== expectations.workspacePath) {
    return createExecutionFailure('CONTEXT_WORKSPACE_MISMATCH');
  }

  if (options.poolProofExpectations) {
    const p = options.poolProofExpectations;
    if (input.pi_runtime_parent !== p.piRuntimeParent) {
      return createExecutionFailure('CONTEXT_PI_RUNTIME_MISMATCH');
    }
    if (input.pi_session_dir !== p.piSessionDir) {
      return createExecutionFailure('CONTEXT_PI_SESSION_MISMATCH');
    }
    const pi = input.pi_executable_identity as ExecutionContextShape['pi_executable_identity'];
    if (pi.path !== p.piExecutablePath || pi.version !== p.piExecutableVersion || pi.digest !== p.piExecutableDigest) {
      return createExecutionFailure('CONTEXT_PI_EXECUTABLE_MISMATCH');
    }
    const pkg = input.package_identity as ExecutionContextShape['package_identity'];
    if (pkg.path !== p.packagePath || pkg.profile !== p.packageProfile || pkg.digest !== p.packageDigest) {
      return createExecutionFailure('CONTEXT_PACKAGE_MISMATCH');
    }
    const prof = input.profile_identity as ExecutionContextShape['profile_identity'];
    if (prof.name !== p.profileName || prof.path !== p.profilePath || prof.digest !== p.profileDigest) {
      return createExecutionFailure('CONTEXT_PROFILE_MISMATCH');
    }
    if (input.selected_model !== p.selectedModel) {
      return createExecutionFailure('CONTEXT_MODEL_MISMATCH');
    }
    if (input.tool_grants.length !== p.toolGrants.length || !input.tool_grants.every((g, i) => g === p.toolGrants[i])) {
      return createExecutionFailure('CONTEXT_TOOL_GRANT_MISMATCH');
    }
    const ctx = input as ExecutionContextShape;
    if (ctx.result_destination.kind !== 'sqlite' || ctx.result_destination.id !== p.resultDestinationId) {
      return createExecutionFailure('CONTEXT_RESULT_DESTINATION_MISMATCH');
    }
  }

  if (issuedAtMs - now > CLOCK_SKEW_TOLERANCE_MS) return createExecutionFailure('CONTEXT_NOT_YET_VALID');
  if (now >= expiresAtMs || now - issuedAtMs > input.max_age_seconds * 1000) {
    return createExecutionFailure('CONTEXT_STALE');
  }

  const nonceStore = options.nonceStore;
  if (nonceStore) {
    if (nonceStore.has(input.attempt_nonce)) return createExecutionFailure('CONTEXT_REPLAYED');
    nonceStore.add(input.attempt_nonce);
  }

  const context = deepFreeze({ ...input }) as unknown as ExecutionContextShape;
  return Object.freeze({
    context,
    issuedAtMs,
    expiresAtMs,
    toJSON(): Record<string, unknown> {
      return { ...context };
    },
  });
}

function validateResultDestination(input: unknown): { readonly kind: 'sqlite' | 'callback'; readonly id: string } | ExecutionFailure {
  if (!isPlainObject(input)) return createExecutionFailure('CONTEXT_INVALID_FIELD', 'result_destination');
  const allowed = new Set(['kind', 'id']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return createExecutionFailure('CONTEXT_INVALID_FIELD', 'result_destination');
  }
  if (!Object.hasOwn(input, 'kind') || !Object.hasOwn(input, 'id')) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'result_destination');
  }
  if (input.kind !== 'sqlite' && input.kind !== 'callback') {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'result_destination.kind');
  }
  if (!isNonEmptyString(input.id)) return createExecutionFailure('CONTEXT_INVALID_FIELD', 'result_destination.id');
  return { kind: input.kind, id: input.id };
}
