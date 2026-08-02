/**
 * Launcher-owned execution-context validation.
 *
 * Every attempt gets a context the launcher issued for that attempt alone. This
 * module is the fail-closed gate that binds an untrusted marker to the launcher's
 * independent expectations — node, attempt, repository, branch, workspace — and
 * to a launcher-owned freshness budget, before any paid work begins.
 *
 * Freshness is a marker field rather than a constant here so the launcher owns
 * the expectation. The five-minute ceiling from the orchestrator specification
 * still binds: a launcher may be stricter and never laxer.
 */

import {
  createExecutionFailure,
  deepFreeze,
  isPlainObject,
  type ExecutionContextShape,
  type ExecutionFailure,
  type LaunchExpectations,
} from './contracts.ts';
import { findDagTopology } from './dag-exclusion.ts';

/** Absolute freshness ceiling fixed by `docs/raw/specs/orchestrator-spec.md` §2.1. */
export const FRESHNESS_CEILING_SECONDS = 300;

/** Tolerance for launcher/worker clock skew on a not-yet-valid marker. */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

export const SUPPORTED_CONTEXT_SCHEMA_VERSION = 2;

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

export type ValidatedExecutionContext = {
  readonly context: ExecutionContextShape;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly toJSON: () => Record<string, unknown>;
};

export type ValidateExecutionContextOptions = {
  readonly now?: number;
  readonly nonceStore?: ConsumedNonceStore;
};

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

  for (const key of Object.keys(input)) {
    if (!REQUIRED_FIELD_SET.has(key)) return createExecutionFailure('CONTEXT_UNKNOWN_FIELD', key);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(input, key)) return createExecutionFailure('CONTEXT_MISSING_FIELD', key);
  }

  if (input.schema_version !== SUPPORTED_CONTEXT_SCHEMA_VERSION) {
    return createExecutionFailure('CONTEXT_VERSION_UNSUPPORTED');
  }
  if (input.actor !== 'pool-worker') return createExecutionFailure('CONTEXT_INVALID_FIELD', 'actor');
  if (input.issued_by !== 'agent-pool-supervisor') return createExecutionFailure('CONTEXT_UNTRUSTED_ISSUER');

  for (const key of ['node_id', 'attempt_id', 'target_repo', 'target_branch'] as const) {
    if (!isNonEmptyString(input[key])) return createExecutionFailure('CONTEXT_INVALID_FIELD', key);
  }
  if (typeof input.attempt_nonce !== 'string' || !NONCE_PATTERN.test(input.attempt_nonce)) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'attempt_nonce');
  }
  if (typeof input.workspace_path !== 'string' || !ABSOLUTE_WORKSPACE_PATH.test(input.workspace_path)) {
    return createExecutionFailure('CONTEXT_INVALID_FIELD', 'workspace_path');
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
