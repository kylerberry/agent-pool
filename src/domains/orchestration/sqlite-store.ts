/**
 * SQLite-backed Orchestration store.
 *
 * Single trusted controller process writer. Every mutation is transactional,
 * version-checked where required, and bounded by the canonical limits in
 * contracts.ts. The store does not expose a dispatch-capable repository until
 * path validation, foreign keys, WAL mode, and migrations succeed.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  lstatSync,
  mkdirSync,
  constants,
  accessSync,
  openSync,
  closeSync,
  fstatSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import crypto from 'node:crypto';

import type {
  ApprovedNode,
  ApprovedWork,
  BackupHook,
  ImportedWork,
  LeaseCommand,
  OrchestrationError,
  PredictedTouchEvidence,
  PredictedTouchImport,
  ResolvedBuilderRouting,
  SchedulingPolicy,
  WorkerResult,
} from './contracts.ts';
import {
  isPlainObject,
  isResolvedBuilderRouting,
  isSafeArtifactLocator,
  ORCHESTRATION_LIMITS,
  validateLeaseCommand,
  type NodeState,
} from './contracts.ts';
import { isValidTransition } from './lifecycle.ts';

const CURRENT_SCHEMA_VERSION = 5;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS works (
    work_id TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    approval_id TEXT,
    approved_at TEXT,
    approved_head TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS nodes (
    work_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    state TEXT NOT NULL,
    version INTEGER NOT NULL,
    intent TEXT NOT NULL,
    change_spec TEXT NOT NULL,
    acceptance_criteria_json TEXT NOT NULL,
    depends_on_json TEXT NOT NULL,
    criteria_origin_source TEXT NOT NULL,
    criteria_origin_source_id TEXT NOT NULL,
    PRIMARY KEY (work_id, node_id),
    FOREIGN KEY (work_id) REFERENCES works(work_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS dependencies (
    work_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    depends_on_node_id TEXT NOT NULL,
    PRIMARY KEY (work_id, node_id, depends_on_node_id),
    FOREIGN KEY (work_id, node_id) REFERENCES nodes(work_id, node_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attempts (
    attempt_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    state TEXT NOT NULL,
    job_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_id, node_id) REFERENCES nodes(work_id, node_id) ON DELETE CASCADE,
    UNIQUE (work_id, node_id, attempt_number)
  );

  CREATE TABLE IF NOT EXISTS leases (
    attempt_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    owner TEXT NOT NULL,
    token_digest TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS accepted_results (
    attempt_id TEXT PRIMARY KEY,
    result_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    phase TEXT NOT NULL,
    artifact_path TEXT,
    summary TEXT,
    accepted_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS completion_authorizations (
    attempt_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    result_id TEXT NOT NULL,
    expected_node_version INTEGER NOT NULL,
    authorized_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scheduling_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    blocker_node_id TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_id) REFERENCES works(work_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id TEXT,
    node_id TEXT,
    attempt_id TEXT,
    event TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_work ON nodes(work_id);
  CREATE INDEX IF NOT EXISTS idx_dependencies_work ON dependencies(work_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_work_node ON attempts(work_id, node_id);
  CREATE INDEX IF NOT EXISTS idx_scheduling_work ON scheduling_decisions(work_id);
  `,
  // v2: ensure provenance columns exist for deployments that started at v1.
  `
  ALTER TABLE attempts ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accepted_results ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accepted_results ADD COLUMN expected_node_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE scheduling_decisions ADD COLUMN repo TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN branch TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN approved_head TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN graph_revision TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN manifest_digest TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN algorithm_version TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN policy_version TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN gate1_approval_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE scheduling_decisions ADD COLUMN classification TEXT NOT NULL DEFAULT '';
  ALTER TABLE works ADD COLUMN frozen_graph_revision TEXT;
  ALTER TABLE works ADD COLUMN frozen_manifest_digest TEXT;
  ALTER TABLE works ADD COLUMN frozen_algorithm_version TEXT;
  ALTER TABLE works ADD COLUMN frozen_policy_version TEXT;
  ALTER TABLE works ADD COLUMN frozen_evidence_id TEXT;
  ALTER TABLE works ADD COLUMN frozen_at TEXT;
  `,
  // v3: append-only attempt provenance.
  //
  // Both tables are insert-only and enforce that in the database, not merely by
  // the absence of a store method. A future migration that must rewrite either
  // one has to DROP the trigger, apply the change, and recreate the trigger
  // inside that migration's single transaction; that is the only sanctioned
  // mutation path.
  //
  // Neither table cascades from attempts: provenance outlives attempt-row
  // cleanup, which is the whole point of recording it.
  `
  CREATE TABLE IF NOT EXISTS attempt_routing_decisions (
    attempt_id TEXT PRIMARY KEY,
    builder_model TEXT NOT NULL,
    evaluator_model TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS phase_artifacts (
    attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (attempt_id, phase, revision)
  );

  CREATE INDEX IF NOT EXISTS idx_phase_artifacts_attempt ON phase_artifacts(attempt_id, phase, revision);

  CREATE TRIGGER IF NOT EXISTS trg_phase_artifacts_no_update
  BEFORE UPDATE ON phase_artifacts
  BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS trg_phase_artifacts_no_delete
  BEFORE DELETE ON phase_artifacts
  BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS trg_attempt_routing_no_update
  BEFORE UPDATE ON attempt_routing_decisions
  BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS trg_attempt_routing_no_delete
  BEFORE DELETE ON attempt_routing_decisions
  BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;
  `,
  // v4: close the INSERT OR REPLACE bypass.
  //
  // REPLACE resolves a conflict by deleting the existing row, and SQLite only
  // fires BEFORE DELETE for that implicit delete when recursive_triggers is ON.
  // That pragma is per-connection, so relying on it protects only connections
  // this store opens — any other writer inherits the default of OFF and can
  // rewrite a recorded grading outcome straight through both triggers.
  //
  // A BEFORE INSERT conflict guard always fires, because REPLACE is still an
  // INSERT, so the guarantee holds regardless of who opened the connection.
  `
  CREATE TRIGGER IF NOT EXISTS trg_phase_artifacts_no_replace
  BEFORE INSERT ON phase_artifacts
  WHEN EXISTS (
    SELECT 1 FROM phase_artifacts
    WHERE attempt_id = NEW.attempt_id AND phase = NEW.phase AND revision = NEW.revision
  )
  BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS trg_attempt_routing_no_replace
  BEFORE INSERT ON attempt_routing_decisions
  WHEN EXISTS (SELECT 1 FROM attempt_routing_decisions WHERE attempt_id = NEW.attempt_id)
  BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;
  `,
  // v5: attempt provenance records only the builder selected at dispatch.
  // Evaluator execution evidence is deferred to grading, where it can be
  // recorded at invocation rather than inferred from builder dispatch. Phase
  // artifacts must always refer to an existing attempt, but restrict deletion
  // rather than cascading away history.
  `
  DROP TRIGGER IF EXISTS trg_phase_artifacts_no_update;
  DROP TRIGGER IF EXISTS trg_phase_artifacts_no_delete;
  DROP TRIGGER IF EXISTS trg_phase_artifacts_no_replace;
  DROP TRIGGER IF EXISTS trg_attempt_routing_no_update;
  DROP TRIGGER IF EXISTS trg_attempt_routing_no_delete;
  DROP TRIGGER IF EXISTS trg_attempt_routing_no_replace;
  DROP INDEX IF EXISTS idx_phase_artifacts_attempt;

  ALTER TABLE attempt_routing_decisions RENAME TO attempt_routing_decisions_v4;
  ALTER TABLE phase_artifacts RENAME TO phase_artifacts_v4;

  CREATE TABLE attempt_routing_decisions (
    attempt_id TEXT PRIMARY KEY,
    builder_model TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE phase_artifacts (
    attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (attempt_id, phase, revision),
    FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT
  );

  INSERT INTO attempt_routing_decisions (attempt_id, builder_model, policy_version, created_at)
  SELECT attempt_id, builder_model, policy_version, created_at
  FROM attempt_routing_decisions_v4;

  INSERT INTO phase_artifacts (attempt_id, phase, revision, status, content_hash, artifact_path, created_at)
  SELECT attempt_id, phase, revision, status, content_hash, artifact_path, created_at
  FROM phase_artifacts_v4;

  DROP TABLE attempt_routing_decisions_v4;
  DROP TABLE phase_artifacts_v4;

  CREATE INDEX idx_phase_artifacts_attempt ON phase_artifacts(attempt_id, phase, revision);

  CREATE TRIGGER trg_phase_artifacts_no_update
  BEFORE UPDATE ON phase_artifacts
  BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;

  CREATE TRIGGER trg_phase_artifacts_no_delete
  BEFORE DELETE ON phase_artifacts
  BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;

  CREATE TRIGGER trg_phase_artifacts_no_replace
  BEFORE INSERT ON phase_artifacts
  WHEN EXISTS (
    SELECT 1 FROM phase_artifacts
    WHERE attempt_id = NEW.attempt_id AND phase = NEW.phase AND revision = NEW.revision
  )
  BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;

  CREATE TRIGGER trg_attempt_routing_no_update
  BEFORE UPDATE ON attempt_routing_decisions
  BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;

  CREATE TRIGGER trg_attempt_routing_no_delete
  BEFORE DELETE ON attempt_routing_decisions
  BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;

  CREATE TRIGGER trg_attempt_routing_no_replace
  BEFORE INSERT ON attempt_routing_decisions
  WHEN EXISTS (SELECT 1 FROM attempt_routing_decisions WHERE attempt_id = NEW.attempt_id)
  BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;
  `,
];

export type NodeRecord = {
  readonly work_id: string;
  readonly node_id: string;
  readonly state: NodeState;
  readonly version: number;
  readonly intent: string;
  readonly change_spec: string;
  readonly acceptance_criteria_json: string;
  readonly depends_on_json: string;
  readonly criteria_origin_source: 'decomposition' | 'direct_task';
  readonly criteria_origin_source_id: string;
};

export type AttemptRecord = {
  readonly attempt_id: string;
  readonly work_id: string;
  readonly node_id: string;
  readonly attempt_number: number;
  readonly state: 'created' | 'leased' | 'result_accepted' | 'completed';
  readonly job_id: string | null;
  readonly created_at: string;
  readonly lease_generation: number;
};

export type LeaseRecord = {
  readonly attempt_id: string;
  readonly generation: number;
  readonly owner: string;
  readonly token_digest: string;
  readonly issued_at: string;
  readonly expires_at: string;
};

export type WorkRecord = {
  readonly work_id: string;
  readonly origin: WorkOrigin;
  readonly repo: string;
  readonly branch: string;
  readonly payload_hash: string;
  readonly approval_id: string | null;
  readonly approved_at: string | null;
  readonly approved_head: string | null;
  readonly version: number;
  readonly frozen_graph_revision: string | null;
  readonly frozen_manifest_digest: string | null;
  readonly frozen_algorithm_version: string | null;
  readonly frozen_policy_version: string | null;
  readonly frozen_evidence_id: string | null;
  readonly frozen_at: string | null;
};

type WorkOrigin = 'decomposition' | 'direct_task';

/** Append-only builder routing provenance for one attempt. */
export type AttemptBuilderRoutingRecord = {
  readonly attempt_id: string;
  readonly builder_model: string;
  readonly policy_version: number;
  readonly created_at: string;
};

/** One immutable revision of one phase's artifact within one attempt. */
export type PhaseArtifactRecord = {
  readonly attempt_id: string;
  readonly phase: string;
  readonly revision: number;
  readonly status: string;
  readonly content_hash: string;
  readonly artifact_path: string;
  readonly created_at: string;
};

/**
 * `revision` is never accepted from the caller; the store allocates it inside
 * the insert transaction.
 */
export type PhaseArtifactInput = {
  readonly attempt_id: string;
  readonly phase: string;
  readonly status: string;
  readonly content_hash: string;
  readonly artifact_path: string;
};

export type OrchestrationStore = {
  readonly importApprovedWork: (work: ApprovedWork) => Promise<ImportedWork | { readonly error: OrchestrationError }>;
  readonly getImportedWork: (workId: string) => Promise<ImportedWork | null>;
  readonly getWork: (workId: string) => Promise<{ readonly repo: string; readonly branch: string } | null>;
  readonly getApprovedNode: (workId: string, nodeId: string) => Promise<ApprovedNode | null>;
  readonly listNodes: (workId: string) => Promise<readonly NodeRecord[]>;
  readonly transitionNode: (workId: string, nodeId: string, expectedVersion: number, newState: NodeState) => Promise<NodeRecord | { readonly error: OrchestrationError }>;
  readonly createAttempt: (
    workId: string,
    nodeId: string,
    attemptId: string,
    attemptNumber: number,
    jobId: string,
    builderRouting: ResolvedBuilderRouting,
  ) => Promise<AttemptRecord | { readonly error: OrchestrationError }>;
  readonly getBuilderRoutingByAttemptId: (attemptId: string) => Promise<AttemptBuilderRoutingRecord | null>;
  readonly recordPhaseArtifact: (input: PhaseArtifactInput) => Promise<PhaseArtifactRecord | { readonly error: OrchestrationError }>;
  readonly getLatestPhaseArtifact: (attemptId: string, phase: string) => Promise<PhaseArtifactRecord | null>;
  readonly getPhaseArtifactRevisions: (attemptId: string, phase: string) => Promise<readonly PhaseArtifactRecord[]>;
  readonly getAttempt: (attemptId: string) => Promise<AttemptRecord | null>;
  readonly getAttemptByJob: (jobId: string) => Promise<AttemptRecord | null>;
  readonly getActiveAttemptForNode: (workId: string, nodeId: string) => Promise<AttemptRecord | null>;
  readonly setJobId: (attemptId: string, jobId: string) => Promise<void>;
  readonly claimLease: (command: LeaseCommand & { kind: 'claim' }, expiresAt: Date, issuedAt: Date) => Promise<{ readonly generation: number; readonly token: string } | { readonly error: OrchestrationError }>;
  readonly getLease: (attemptId: string) => Promise<LeaseRecord | null>;
  readonly renewLease: (command: LeaseCommand & { kind: 'renew' }, expiresAt: Date, now: Date) => Promise<{ readonly generation: number } | { readonly error: OrchestrationError }>;
  readonly releaseLease: (command: LeaseCommand & { kind: 'release' }, now: Date) => Promise<{ readonly ok: boolean; readonly error?: OrchestrationError }>;
  readonly reclaimLease: (attemptId: string, owner: string, now: Date) => Promise<{ readonly generation: number } | { readonly error: OrchestrationError }>;
  readonly acceptResult: (result: WorkerResult, now: Date) => Promise<{ readonly ok: boolean; readonly error?: OrchestrationError }>;
  readonly getAcceptedResult: (attemptId: string) => Promise<WorkerResult | null>;
  readonly completeAuthorizedResult: (workId: string, nodeId: string, attemptId: string) => Promise<NodeRecord | { readonly error: OrchestrationError }>;
  readonly importPredictedTouch: (workId: string, evidence: PredictedTouchEvidence, policy: SchedulingPolicy) => Promise<PredictedTouchImport | { readonly error: OrchestrationError }>;
  readonly getSchedulingBlockers: (workId: string) => Promise<ReadonlyMap<string, string>>;
  readonly listAttemptsNeedingReconciliation: (now: Date) => Promise<readonly AttemptRecord[]>;
  readonly listAuthorizedResults: () => Promise<readonly { readonly attempt_id: string; readonly node_id: string; readonly work_id: string; readonly result_id: string; readonly expected_node_version: number }[]>;
  readonly listCreatedAttempts: () => Promise<readonly AttemptRecord[]>;
  readonly close: () => Promise<void>;
};

function err(code: OrchestrationError['code'], message: string): { readonly error: OrchestrationError } {
  return { error: { code, message } };
}

function isNonEmptyString(value: unknown, max = Infinity): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

const CRAFTS_PHASES = new Set(['C', 'R', 'A', 'F', 'T', 'S']);
const PHASE_ARTIFACT_STATUSES = new Set(['passed', 'needs_fix', 'failed', 'blocked']);

function isCraftsPhase(value: unknown): value is string {
  return typeof value === 'string' && CRAFTS_PHASES.has(value);
}

function isPhaseArtifactStatus(value: unknown): value is string {
  return typeof value === 'string' && PHASE_ARTIFACT_STATUSES.has(value);
}

function isOptionalString(value: unknown, max = Infinity): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function hasOwnField(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key);
}

function ownOrMissing(obj: Record<string, unknown>, key: string): boolean {
  return hasOwnField(obj, key) || obj[key] === undefined;
}

function validateWork(work: unknown): OrchestrationError | null {
  if (!isPlainObject(work)) {
    return { code: 'INVALID_WORK', message: 'work must be an object' };
  }

  const allowedWork = new Set([
    'work_id', 'origin', 'repo', 'branch', 'payload_hash', 'approval_id', 'approved_at', 'approved_head', 'nodes',
  ]);
  for (const key of Object.keys(work)) {
    if (!allowedWork.has(key)) {
      return { code: 'INVALID_WORK', message: `unknown field ${key}` };
    }
  }

  if (!hasOwnField(work, 'work_id')) {
    return { code: 'INVALID_WORK', message: 'missing work_id' };
  }
  if (!isNonEmptyString(work.work_id, ORCHESTRATION_LIMITS.maxIdLength)) {
    return { code: 'INVALID_WORK', message: 'invalid work_id' };
  }
  if (!hasOwnField(work, 'origin')) {
    return { code: 'INVALID_WORK', message: 'missing origin' };
  }
  if (work.origin !== 'decomposition' && work.origin !== 'direct_task') {
    return { code: 'INVALID_WORK', message: 'invalid origin' };
  }
  if (!hasOwnField(work, 'repo')) {
    return { code: 'INVALID_WORK', message: 'missing repo' };
  }
  if (!isNonEmptyString(work.repo, ORCHESTRATION_LIMITS.maxRepoLength)) {
    return { code: 'INVALID_WORK', message: 'invalid repo' };
  }
  if (!hasOwnField(work, 'branch')) {
    return { code: 'INVALID_WORK', message: 'missing branch' };
  }
  if (!isNonEmptyString(work.branch, ORCHESTRATION_LIMITS.maxBranchLength)) {
    return { code: 'INVALID_WORK', message: 'invalid branch' };
  }
  if (!hasOwnField(work, 'payload_hash')) {
    return { code: 'INVALID_WORK', message: 'missing payload_hash' };
  }
  if (!isNonEmptyString(work.payload_hash, ORCHESTRATION_LIMITS.maxDigestLength)) {
    return { code: 'INVALID_WORK', message: 'invalid payload_hash' };
  }
  if (!ownOrMissing(work, 'approval_id')) {
    return { code: 'INVALID_WORK', message: 'inherited approval_id' };
  }
  if (!isOptionalString(work.approval_id, ORCHESTRATION_LIMITS.maxIdLength)) {
    return { code: 'INVALID_WORK', message: 'invalid approval_id' };
  }
  if (!ownOrMissing(work, 'approved_at')) {
    return { code: 'INVALID_WORK', message: 'inherited approved_at' };
  }
  if (!isOptionalString(work.approved_at, ORCHESTRATION_LIMITS.maxVersionLength)) {
    return { code: 'INVALID_WORK', message: 'invalid approved_at' };
  }
  if (!ownOrMissing(work, 'approved_head')) {
    return { code: 'INVALID_WORK', message: 'inherited approved_head' };
  }
  if (!isOptionalString(work.approved_head, ORCHESTRATION_LIMITS.maxDigestLength)) {
    return { code: 'INVALID_WORK', message: 'invalid approved_head' };
  }
  if (work.origin === 'decomposition') {
    if (!isNonEmptyString(work.approval_id, ORCHESTRATION_LIMITS.maxIdLength) ||
        !isNonEmptyString(work.approved_at, ORCHESTRATION_LIMITS.maxVersionLength) ||
        !isNonEmptyString(work.approved_head, ORCHESTRATION_LIMITS.maxDigestLength)) {
      return { code: 'INVALID_WORK', message: 'decomposed work requires Gate-1 approval_id, approved_at, and approved_head' };
    }
  }

  if (!hasOwnField(work, 'nodes')) {
    return { code: 'INVALID_WORK', message: 'missing nodes' };
  }
  const rawNodes = work.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0 || rawNodes.length > ORCHESTRATION_LIMITS.maxNodes) {
    return { code: 'INVALID_WORK', message: 'invalid nodes' };
  }

  const nodeIds = new Set<string>();
  const nodes: Array<Record<string, unknown>> = [];
  for (const rawNode of rawNodes) {
    if (!isPlainObject(rawNode)) {
      return { code: 'INVALID_WORK', message: 'node must be an object' };
    }
    const allowedNode = new Set([
      'id', 'intent', 'change_spec', 'acceptance_criteria', 'depends_on', 'criteria_origin_source', 'criteria_origin_source_id',
    ]);
    for (const key of Object.keys(rawNode)) {
      if (!allowedNode.has(key)) {
        return { code: 'INVALID_WORK', message: `unknown node field ${key}` };
      }
    }

    const node = rawNode as Record<string, unknown>;
    if (!hasOwnField(node, 'id')) {
      return { code: 'INVALID_WORK', message: 'missing node id' };
    }
    if (!isNonEmptyString(node.id, ORCHESTRATION_LIMITS.maxIdLength)) {
      return { code: 'INVALID_WORK', message: 'invalid node id' };
    }
    if (nodeIds.has(node.id)) {
      return { code: 'DUPLICATE_WORK', message: `duplicate node id ${node.id}` };
    }
    nodeIds.add(node.id);
    if (!hasOwnField(node, 'intent')) {
      return { code: 'INVALID_WORK', message: 'missing intent' };
    }
    if (!isNonEmptyString(node.intent, ORCHESTRATION_LIMITS.maxTextLength)) {
      return { code: 'INVALID_WORK', message: 'invalid intent' };
    }
    if (!hasOwnField(node, 'change_spec')) {
      return { code: 'INVALID_WORK', message: 'missing change_spec' };
    }
    if (!isNonEmptyString(node.change_spec, ORCHESTRATION_LIMITS.maxTextLength)) {
      return { code: 'INVALID_WORK', message: 'invalid change_spec' };
    }

    if (!hasOwnField(node, 'acceptance_criteria')) {
      return { code: 'INVALID_WORK', message: 'missing acceptance criteria' };
    }
    const criteria = node.acceptance_criteria;
    if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > ORCHESTRATION_LIMITS.maxCriteriaPerNode) {
      return { code: 'INVALID_WORK', message: 'invalid acceptance criteria' };
    }
    for (const criterion of criteria) {
      if (!isNonEmptyString(criterion, ORCHESTRATION_LIMITS.maxTextLength)) {
        return { code: 'INVALID_WORK', message: 'invalid criterion' };
      }
    }

    if (!hasOwnField(node, 'depends_on')) {
      return { code: 'INVALID_WORK', message: 'missing depends_on' };
    }
    const deps = node.depends_on;
    if (!Array.isArray(deps) || deps.length > ORCHESTRATION_LIMITS.maxDependenciesPerNode) {
      return { code: 'INVALID_WORK', message: 'invalid depends_on' };
    }
    for (const dep of deps) {
      if (!isNonEmptyString(dep, ORCHESTRATION_LIMITS.maxIdLength)) {
        return { code: 'INVALID_WORK', message: 'invalid dependency id' };
      }
    }

    if (!hasOwnField(node, 'criteria_origin_source')) {
      return { code: 'INVALID_WORK', message: 'missing criteria_origin_source' };
    }
    if (node.criteria_origin_source !== 'decomposition' && node.criteria_origin_source !== 'direct_task') {
      return { code: 'INVALID_WORK', message: 'invalid criteria_origin_source' };
    }
    if (!hasOwnField(node, 'criteria_origin_source_id')) {
      return { code: 'INVALID_WORK', message: 'missing criteria_origin_source_id' };
    }
    if (!isNonEmptyString(node.criteria_origin_source_id, ORCHESTRATION_LIMITS.maxIdLength)) {
      return { code: 'INVALID_WORK', message: 'invalid criteria_origin_source_id' };
    }

    nodes.push(node);
  }

  for (const node of nodes) {
    const deps = node.depends_on as string[];
    for (const dep of deps) {
      if (!nodeIds.has(dep)) {
        return { code: 'INVALID_WORK', message: `unknown dependency ${dep}` };
      }
      if (dep === node.id) {
        return { code: 'INVALID_WORK', message: `self dependency ${node.id}` };
      }
    }
  }

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id as string, (node.depends_on as string[]).length);
    adj.set(node.id as string, []);
  }
  for (const node of nodes) {
    for (const dep of node.depends_on as string[]) {
      adj.get(dep)!.push(node.id as string);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed += 1;
    for (const child of adj.get(id) ?? []) {
      const d = inDegree.get(child)! - 1;
      inDegree.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  if (processed !== nodes.length) {
    return { code: 'INVALID_WORK', message: 'dependency cycle detected' };
  }
  return null;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function canonicalWorkHash(work: ApprovedWork): string {
  const canonical = {
    work_id: work.work_id,
    origin: work.origin,
    repo: work.repo,
    branch: work.branch,
    payload_hash: work.payload_hash,
    approval_id: work.approval_id,
    approved_at: work.approved_at,
    approved_head: work.approved_head,
    nodes: work.nodes.map((n) => ({
      id: n.id,
      intent: n.intent,
      change_spec: n.change_spec,
      acceptance_criteria: [...n.acceptance_criteria],
      depends_on: [...n.depends_on].sort(),
      criteria_origin_source: n.criteria_origin_source,
      criteria_origin_source_id: n.criteria_origin_source_id,
    })),
  };
  return digest(JSON.stringify(canonical));
}

function modeAllowsOwnerOnly(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function validatePrivatePath(runtimeRoot: string, dbLocation: string): { readonly targetPath: string; readonly fd: number } {
  const resolvedRoot = resolve(runtimeRoot);
  if (!isAbsolute(resolvedRoot)) {
    throw new Error('runtimeRoot must be absolute');
  }

  let rootStat;
  try {
    rootStat = lstatSync(resolvedRoot);
  } catch (e) {
    throw new Error(`runtimeRoot does not exist: ${(e as Error).message}`);
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error('runtimeRoot is a symlink');
  }
  if (!rootStat.isDirectory()) {
    throw new Error('runtimeRoot is not a directory');
  }
  if (process.getuid !== undefined && rootStat.uid !== process.getuid()) {
    throw new Error('runtimeRoot is not owned by the effective user');
  }
  if (!modeAllowsOwnerOnly(rootStat.mode)) {
    throw new Error('runtimeRoot is not owner-only');
  }

  if (isAbsolute(dbLocation)) {
    throw new Error('dbLocation outside private runtime root: absolute path not allowed');
  }
  if (dbLocation.includes('..') || dbLocation.startsWith('./..') || dbLocation.startsWith('../')) {
    throw new Error('dbLocation outside private runtime root: traversal not allowed');
  }
  const target = resolve(resolvedRoot, dbLocation);
  const rel = relative(resolvedRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('resolved dbLocation is outside private runtime root');
  }

  const parts = dbLocation.split('/').filter((p) => p.length > 0 && p !== '.');
  let current = resolvedRoot;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = join(current, parts[i]!);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new Error(`symlinked parent component ${parts[i]}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`parent component ${parts[i]} is not a directory`);
      }
      if (process.getuid !== undefined && st.uid !== process.getuid()) {
        throw new Error(`parent component ${parts[i]} is not owned by the effective user`);
      }
      if (!modeAllowsOwnerOnly(st.mode)) {
        throw new Error(`parent component ${parts[i]} is not owner-only`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        mkdirSync(current, { mode: 0o700, recursive: true });
        continue;
      }
      throw e;
    }
  }

  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new Error('database target is a symlink');
    }
    if (!st.isFile()) {
      throw new Error('database target is not a regular file');
    }
    if (process.getuid !== undefined && st.uid !== process.getuid()) {
      throw new Error('database target is not owned by the effective user');
    }
    if (!modeAllowsOwnerOnly(st.mode)) {
      throw new Error('database target is not owner-only');
    }
    try {
      accessSync(target, constants.W_OK);
    } catch {
      throw new Error('database target is not writable');
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  let fd: number;
  let created = false;
  try {
    try {
      fd = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        fd = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
        created = true;
      } else {
        throw e;
      }
    }
  } catch (e) {
    throw new Error(`failed to open database safely: ${(e as Error).message}`);
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error('database target is not a regular file');
    }
    if (process.getuid !== undefined && st.uid !== process.getuid()) {
      throw new Error('database target is not owned by the effective user');
    }
    if (!modeAllowsOwnerOnly(st.mode)) {
      throw new Error('database target is not owner-only');
    }

    const realTarget = realpathSync(target);
    const realRel = relative(resolvedRoot, realTarget);
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error('database target resolves outside private runtime root');
    }
  } catch (e) {
    closeSync(fd);
    if (created) {
      try {
        unlinkSync(target);
      } catch {}
    }
    throw e;
  }

  return { targetPath: target, fd };
}

async function runMigrations(db: DatabaseSync, backupHook: BackupHook | undefined, targetPath: string): Promise<void> {
  let current = 0;
  try {
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
    current = row?.version ?? 0;
  } catch (e) {
    if (!((e as NodeJS.ErrnoException).message?.includes('no such table') ?? false)) {
      throw e;
    }
    current = 0;
  }
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error('database schema is newer than this code: fail closed');
  }
  if (current === CURRENT_SCHEMA_VERSION) return;
  if (current > 0 && backupHook) {
    await backupHook(targetPath);
  }
  for (let v = current + 1; v <= CURRENT_SCHEMA_VERSION; v += 1) {
    const sql = MIGRATIONS[v - 1];
    if (!sql) {
      throw new Error(`missing migration for version ${v}`);
    }
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?);').run(v, new Date().toISOString());
      db.exec('COMMIT;');
    } catch (e) {
      try {
        db.exec('ROLLBACK;');
      } catch {}
      throw new Error(`migration to version ${v} failed: ${(e as Error).message}`);
    }
  }
}

export async function createSqliteStore(config: {
  readonly runtimeRoot: string;
  readonly dbLocation: string;
  readonly backupHook?: BackupHook;
}): Promise<OrchestrationStore> {
  const { targetPath, fd } = validatePrivatePath(config.runtimeRoot, config.dbLocation);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(targetPath);
  } finally {
    closeSync(fd);
  }
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    // Defence in depth only. recursive_triggers is per-connection, so it stops
    // this connection from bypassing BEFORE DELETE via REPLACE but does nothing
    // about a connection opened elsewhere with SQLite's default of OFF. The
    // guarantee that actually holds is the schema-level BEFORE INSERT conflict
    // guard added in migration v4.
    db.exec('PRAGMA recursive_triggers = ON;');
    await runMigrations(db, config.backupHook, targetPath);
  } catch (e) {
    db.close();
    throw e;
  }

  function audit(event: string, details: Record<string, unknown>, ids: { workId?: string; nodeId?: string; attemptId?: string } = {}) {
    db.prepare('INSERT INTO audit (work_id, node_id, attempt_id, event, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?);').run(
      ids.workId ?? null,
      ids.nodeId ?? null,
      ids.attemptId ?? null,
      event,
      JSON.stringify(details),
      new Date().toISOString(),
    );
  }

  const store: OrchestrationStore = {
    async importApprovedWork(work) {
      const validation = validateWork(work);
      if (validation) return err(validation.code, validation.message);

      const existing = db.prepare('SELECT payload_hash FROM works WHERE work_id = ?').get(work.work_id) as { payload_hash: string } | undefined;
      if (existing) {
        if (existing.payload_hash === canonicalWorkHash(work)) {
          return { work_id: work.work_id, version: 1 };
        }
        return err('CONFLICTING_WORK', 'work_id already imported with different content');
      }

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(
          'INSERT INTO works (work_id, origin, repo, branch, payload_hash, approval_id, approved_at, approved_head, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1);',
        ).run(
          work.work_id,
          work.origin,
          work.repo,
          work.branch,
          canonicalWorkHash(work),
          work.approval_id ?? null,
          work.approved_at ?? null,
          work.approved_head ?? null,
        );
        for (const node of work.nodes) {
          db.prepare(
            'INSERT INTO nodes (work_id, node_id, state, version, intent, change_spec, acceptance_criteria_json, depends_on_json, criteria_origin_source, criteria_origin_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
          ).run(
            work.work_id,
            node.id,
            'pending',
            1,
            node.intent,
            node.change_spec,
            JSON.stringify([...node.acceptance_criteria]),
            JSON.stringify([...node.depends_on]),
            node.criteria_origin_source,
            node.criteria_origin_source_id,
          );
          for (const dep of node.depends_on) {
            db.prepare('INSERT INTO dependencies (work_id, node_id, depends_on_node_id) VALUES (?, ?, ?);').run(work.work_id, node.id, dep);
          }
        }
        db.exec('COMMIT;');
        audit('work_imported', { origin: work.origin, node_count: work.nodes.length }, { workId: work.work_id });
        return { work_id: work.work_id, version: 1 };
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('INVALID_WORK', (e as Error).message);
      }
    },

    async getImportedWork(workId) {
      const row = db.prepare('SELECT work_id, version FROM works WHERE work_id = ?').get(workId) as { work_id: string; version: number } | undefined;
      return row ? { work_id: row.work_id, version: row.version } : null;
    },

    async getWork(workId) {
      const row = db.prepare('SELECT repo, branch FROM works WHERE work_id = ?').get(workId) as { repo: string; branch: string } | undefined;
      return row ?? null;
    },

    async getApprovedNode(workId, nodeId) {
      const row = db.prepare('SELECT * FROM nodes WHERE work_id = ? AND node_id = ?').get(workId, nodeId) as NodeRecord | undefined;
      if (!row) return null;
      return {
        id: row.node_id,
        intent: row.intent,
        change_spec: row.change_spec,
        acceptance_criteria: JSON.parse(row.acceptance_criteria_json),
        depends_on: JSON.parse(row.depends_on_json),
        criteria_origin_source: row.criteria_origin_source,
        criteria_origin_source_id: row.criteria_origin_source_id,
      };
    },

    async listNodes(workId) {
      const rows = db.prepare('SELECT * FROM nodes WHERE work_id = ? ORDER BY node_id').all(workId) as NodeRecord[];
      return rows;
    },

    async transitionNode(workId, nodeId, expectedVersion, newState) {
      if (!isValidTransition('pending', newState) && !isValidTransition('ready', newState) && !isValidTransition('in_progress', newState)) {
        return err('INVALID_TRANSITION', `transition to ${newState} is not allowed`);
      }
      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = db.prepare('SELECT state, version FROM nodes WHERE work_id = ? AND node_id = ?').get(workId, nodeId) as { state: NodeState; version: number } | undefined;
        if (!row) {
          db.exec('ROLLBACK;');
          return err('NODE_NOT_FOUND', 'node not found');
        }
        if (row.version !== expectedVersion) {
          db.exec('ROLLBACK;');
          return err('STALE_VERSION', 'expected version mismatch');
        }
        if (!isValidTransition(row.state, newState)) {
          db.exec('ROLLBACK;');
          return err('INVALID_TRANSITION', `transition from ${row.state} to ${newState} is not allowed`);
        }
        db.prepare('UPDATE nodes SET state = ?, version = version + 1 WHERE work_id = ? AND node_id = ? AND version = ?;').run(newState, workId, nodeId, expectedVersion);
        db.exec('COMMIT;');
        audit('node_transitioned', { from: row.state, to: newState, expected_version: expectedVersion }, { workId, nodeId });
        return (await store.listNodes(workId)).find((n) => n.node_id === nodeId)!;
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('INVALID_TRANSITION', (e as Error).message);
      }
    },

    async createAttempt(workId, nodeId, attemptId, attemptNumber, jobId, builderRouting) {
      if (!isNonEmptyString(attemptId, ORCHESTRATION_LIMITS.maxIdLength) || !isNonEmptyString(jobId, ORCHESTRATION_LIMITS.maxIdLength)) {
        return err('INVALID_RESULT', 'invalid attempt or job id');
      }
      if (!isPositiveInteger(attemptNumber)) {
        return err('INVALID_RESULT', 'invalid attempt number');
      }
      // Builder provenance is a precondition of the attempt existing at all.
      // Evaluator-execution provenance is deferred until grading actually runs
      // an evaluator; this store must not infer it from builder dispatch.
      if (!isResolvedBuilderRouting(builderRouting)) {
        return err('INVALID_RESULT', 'attempt requires resolved builder routing');
      }
      db.exec('BEGIN IMMEDIATE;');
      try {
        const nodeRow = db.prepare('SELECT state, version FROM nodes WHERE work_id = ? AND node_id = ?').get(workId, nodeId) as { state: NodeState; version: number } | undefined;
        if (!nodeRow) {
          db.exec('ROLLBACK;');
          return err('NODE_NOT_FOUND', 'node not found');
        }
        if (nodeRow.state !== 'ready') {
          db.exec('ROLLBACK;');
          return err('INVALID_TRANSITION', 'attempts can only be created for ready nodes');
        }
        const existing = db.prepare('SELECT attempt_id FROM attempts WHERE attempt_id = ?').get(attemptId) as { attempt_id: string } | undefined;
        if (existing) {
          db.exec('COMMIT;');
          return (await store.getAttempt(attemptId))!;
        }
        const createdAt = new Date().toISOString();
        db.prepare(
          'INSERT INTO attempts (attempt_id, work_id, node_id, attempt_number, state, job_id, created_at, lease_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
        ).run(attemptId, workId, nodeId, attemptNumber, 'created', jobId, createdAt, 0);
        // Same transaction as the attempts row: no attempt can exist without
        // the builder provenance that governed it.
        db.prepare(
          'INSERT INTO attempt_routing_decisions (attempt_id, builder_model, policy_version, created_at) VALUES (?, ?, ?, ?);',
        ).run(attemptId, builderRouting.builder, builderRouting.policyVersion, createdAt);
        db.exec('COMMIT;');
        audit('attempt_created', { attempt_id: attemptId, attempt_number: attemptNumber, job_id: jobId }, { workId, nodeId, attemptId });
        return (await store.getAttempt(attemptId))!;
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('INVALID_RESULT', (e as Error).message);
      }
    },

    async getAttempt(attemptId) {
      return (db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId) as AttemptRecord | undefined) ?? null;
    },

    async getBuilderRoutingByAttemptId(attemptId) {
      if (!isNonEmptyString(attemptId, ORCHESTRATION_LIMITS.maxIdLength)) return null;
      return (
        (db
          .prepare('SELECT * FROM attempt_routing_decisions WHERE attempt_id = ?')
          .get(attemptId) as AttemptBuilderRoutingRecord | undefined) ?? null
      );
    },

    async recordPhaseArtifact(input) {
      if (!isPlainObject(input)) return err('INVALID_RESULT', 'phase artifact input must be an object');
      const { attempt_id: attemptId, phase, status, content_hash: contentHash, artifact_path: artifactPath } = input;
      if (!isNonEmptyString(attemptId, ORCHESTRATION_LIMITS.maxIdLength)) return err('INVALID_RESULT', 'invalid attempt id');
      if (!isCraftsPhase(phase)) return err('INVALID_RESULT', 'invalid phase');
      if (!isPhaseArtifactStatus(status)) return err('INVALID_RESULT', 'invalid status');
      if (!isNonEmptyString(contentHash, ORCHESTRATION_LIMITS.maxDigestLength)) return err('INVALID_RESULT', 'invalid content hash');
      // Persisted as a locator only; this domain never opens it.
      if (!isSafeArtifactLocator(artifactPath)) return err('INVALID_RESULT', 'artifact_path is not a safe workspace-relative locator');

      // BEGIN IMMEDIATE is inside the try: when another writer holds the
      // RESERVED lock it raises SQLITE_BUSY, and the declared return type
      // promises a typed error rather than a thrown one. A failure here means
      // no transaction was opened, so there is nothing to roll back.
      try {
        db.exec('BEGIN IMMEDIATE;');
      } catch (e) {
        return err('DATABASE_UNREACHABLE', `could not begin write transaction: ${(e as Error).message}`);
      }
      try {
        // Revision is allocated by the INSERT itself, not by a read-modify-write
        // in application code. MAX and INSERT are one statement under one write
        // lock, so two writers cannot both observe the same maximum regardless
        // of the surrounding transaction mode. This removes the race by
        // construction rather than resting on lock discipline that no in-process
        // test can constrain; UNIQUE remains as the backstop.
        const createdAt = new Date().toISOString();
        db.prepare(
          `INSERT INTO phase_artifacts (attempt_id, phase, revision, status, content_hash, artifact_path, created_at)
           SELECT ?, ?, COALESCE(MAX(revision), 0) + 1, ?, ?, ?, ?
           FROM phase_artifacts WHERE attempt_id = ? AND phase = ?;`,
        ).run(attemptId, phase, status, contentHash, artifactPath, createdAt, attemptId, phase);
        const next = (
          db
            .prepare('SELECT MAX(revision) AS revision FROM phase_artifacts WHERE attempt_id = ? AND phase = ?')
            .get(attemptId, phase) as { revision: number }
        ).revision;
        db.exec('COMMIT;');
        audit('phase_artifact_recorded', { phase, revision: next, status }, { attemptId });
        return { attempt_id: attemptId, phase, revision: next, status, content_hash: contentHash, artifact_path: artifactPath, created_at: createdAt };
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('INVALID_RESULT', (e as Error).message);
      }
    },

    async getLatestPhaseArtifact(attemptId, phase) {
      return (
        (db
          .prepare('SELECT * FROM phase_artifacts WHERE attempt_id = ? AND phase = ? ORDER BY revision DESC LIMIT 1')
          .get(attemptId, phase) as PhaseArtifactRecord | undefined) ?? null
      );
    },

    async getPhaseArtifactRevisions(attemptId, phase) {
      return db
        .prepare('SELECT * FROM phase_artifacts WHERE attempt_id = ? AND phase = ? ORDER BY revision ASC')
        .all(attemptId, phase) as PhaseArtifactRecord[];
    },

    async getAttemptByJob(jobId) {
      return (db.prepare('SELECT * FROM attempts WHERE job_id = ?').get(jobId) as AttemptRecord | undefined) ?? null;
    },

    async getActiveAttemptForNode(workId, nodeId) {
      return (db.prepare("SELECT * FROM attempts WHERE work_id = ? AND node_id = ? AND state IN ('created', 'leased') ORDER BY attempt_number DESC LIMIT 1").get(workId, nodeId) as AttemptRecord | undefined) ?? null;
    },

    async setJobId(attemptId, jobId) {
      db.prepare("UPDATE attempts SET job_id = ?, state = 'created' WHERE attempt_id = ? AND state = 'created';").run(jobId, attemptId);
    },

    async claimLease(command, expiresAt, issuedAt) {
      const validation = validateLeaseCommand(command);
      if (validation) return err(validation.code, validation.message);
      const attemptId = command.attempt_id;
      const owner = command.owner;
      const token = generateToken();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const attempt = db.prepare('SELECT attempt_id, lease_generation FROM attempts WHERE attempt_id = ?').get(attemptId) as { attempt_id: string; lease_generation: number } | undefined;
        if (!attempt) {
          db.exec('ROLLBACK;');
          return err('INVALID_LEASE_COMMAND', 'attempt not found');
        }
        const existing = db.prepare('SELECT generation FROM leases WHERE attempt_id = ?').get(attemptId) as { generation: number } | undefined;
        if (existing) {
          db.exec('ROLLBACK;');
          return err('LEASE_CONFLICT', 'lease already exists');
        }
        const nextGeneration = attempt.lease_generation + 1;
        db.prepare(
          'INSERT INTO leases (attempt_id, generation, owner, token_digest, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?);',
        ).run(attemptId, nextGeneration, owner, digest(token), issuedAt.toISOString(), expiresAt.toISOString());
        db.prepare("UPDATE attempts SET state = 'leased', lease_generation = ? WHERE attempt_id = ?;").run(nextGeneration, attemptId);
        db.exec('COMMIT;');
        audit('lease_claimed', { generation: nextGeneration, owner }, { attemptId });
        return { generation: nextGeneration, token };
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('LEASE_CONFLICT', (e as Error).message);
      }
    },

    async getLease(attemptId) {
      return (db.prepare('SELECT * FROM leases WHERE attempt_id = ?').get(attemptId) as LeaseRecord | undefined) ?? null;
    },

    async renewLease(command, expiresAt, now) {
      const validation = validateLeaseCommand(command);
      if (validation) return err(validation.code, validation.message);
      const attemptId = command.attempt_id;
      const token = command.token;
      db.exec('BEGIN IMMEDIATE;');
      try {
        const lease = db.prepare('SELECT generation, token_digest, owner, expires_at FROM leases WHERE attempt_id = ?').get(attemptId) as { generation: number; token_digest: string; owner: string; expires_at: string } | undefined;
        if (!lease) {
          db.exec('ROLLBACK;');
          return err('LEASE_EXPIRED', 'no current lease');
        }
        if (lease.owner !== command.owner) {
          db.exec('ROLLBACK;');
          return err('INVALID_LEASE_COMMAND', 'owner mismatch');
        }
        if (digest(token) !== lease.token_digest) {
          db.exec('ROLLBACK;');
          return err('INVALID_LEASE_COMMAND', 'token mismatch');
        }
        if (new Date(lease.expires_at) <= now) {
          db.exec('ROLLBACK;');
          return err('LEASE_EXPIRED', 'lease already expired');
        }
        db.prepare('UPDATE leases SET expires_at = ? WHERE attempt_id = ?;').run(expiresAt.toISOString(), attemptId);
        db.exec('COMMIT;');
        audit('lease_renewed', { generation: lease.generation }, { attemptId });
        return { generation: lease.generation };
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('LEASE_EXPIRED', (e as Error).message);
      }
    },

    async releaseLease(command, now) {
      const validation = validateLeaseCommand(command);
      if (validation) return { ok: false, error: validation };
      const attemptId = command.attempt_id;
      const token = command.token;
      db.exec('BEGIN IMMEDIATE;');
      try {
        const lease = db.prepare('SELECT token_digest, owner FROM leases WHERE attempt_id = ?').get(attemptId) as { token_digest: string; owner: string } | undefined;
        if (!lease) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'INVALID_LEASE_COMMAND', message: 'no current lease' } };
        }
        if (lease.owner !== command.owner) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'INVALID_LEASE_COMMAND', message: 'owner mismatch' } };
        }
        if (digest(token) !== lease.token_digest) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'INVALID_LEASE_COMMAND', message: 'token mismatch' } };
        }
        db.prepare('DELETE FROM leases WHERE attempt_id = ?;').run(attemptId);
        db.prepare("UPDATE attempts SET state = 'created' WHERE attempt_id = ?;").run(attemptId);
        db.exec('COMMIT;');
        audit('lease_released', {}, { attemptId });
        return { ok: true };
      } catch (e) {
        db.exec('ROLLBACK;');
        return { ok: false, error: { code: 'LEASE_CONFLICT', message: (e as Error).message } };
      }
    },

    async reclaimLease(attemptId, owner, now) {
      if (!isNonEmptyString(owner, ORCHESTRATION_LIMITS.maxOwnerLength)) {
        return err('INVALID_LEASE_COMMAND', 'invalid owner');
      }
      db.exec('BEGIN IMMEDIATE;');
      try {
        const attempt = db.prepare('SELECT attempt_id, lease_generation FROM attempts WHERE attempt_id = ?').get(attemptId) as { attempt_id: string; lease_generation: number } | undefined;
        if (!attempt) {
          db.exec('ROLLBACK;');
          return err('INVALID_LEASE_COMMAND', 'attempt not found');
        }
        const lease = db.prepare('SELECT generation, expires_at FROM leases WHERE attempt_id = ?').get(attemptId) as { generation: number; expires_at: string } | undefined;
        if (!lease) {
          db.exec('ROLLBACK;');
          return err('LEASE_EXPIRED', 'no lease to reclaim');
        }
        if (new Date(lease.expires_at) > now) {
          db.exec('ROLLBACK;');
          return err('LEASE_CONFLICT', 'lease is not expired');
        }
        db.prepare('DELETE FROM leases WHERE attempt_id = ?;').run(attemptId);
        db.prepare("UPDATE attempts SET state = 'created' WHERE attempt_id = ?;").run(attemptId);
        db.exec('COMMIT;');
        const nextGeneration = attempt.lease_generation + 1;
        audit('lease_reclaimed', { generation: nextGeneration, owner }, { attemptId });
        return { generation: nextGeneration };
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('LEASE_CONFLICT', (e as Error).message);
      }
    },

    async acceptResult(result, now) {
      const validation = validateResult(result);
      if (validation) return { ok: false, error: validation };

      db.exec('BEGIN IMMEDIATE;');
      try {
        const attempt = db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(result.attempt_id) as AttemptRecord | undefined;
        if (!attempt) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'INVALID_RESULT', message: 'attempt not found' } };
        }
        if (attempt.node_id !== result.node_id || attempt.work_id !== result.work_id) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'RESULT_IDENTITY_MISMATCH', message: 'result identity does not match stored attempt' } };
        }

        const existing = db.prepare('SELECT attempt_id, result_id, node_id, work_id, outcome, phase, artifact_path, summary, generation, expected_node_version FROM accepted_results WHERE attempt_id = ?').get(result.attempt_id) as WorkerResult | undefined;
        if (existing) {
          if (resultsEqual(existing, result)) {
            db.exec('ROLLBACK;');
            audit('result_duplicate_ignored', { result_id: result.result_id }, { attemptId: result.attempt_id, workId: result.work_id, nodeId: result.node_id });
            return { ok: true };
          }
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'RESULT_CONFLICT', message: 'result id already used with different content' } };
        }

        const lease = db.prepare('SELECT * FROM leases WHERE attempt_id = ?').get(result.attempt_id) as LeaseRecord | undefined;
        const node = db.prepare('SELECT state, version FROM nodes WHERE work_id = ? AND node_id = ?').get(result.work_id, result.node_id) as { state: NodeState; version: number } | undefined;
        if (!node) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'NODE_NOT_FOUND', message: 'node not found' } };
        }

        if (result.expected_node_version !== node.version) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'STALE_VERSION', message: 'expected node version mismatch' } };
        }

        const leaseValid = lease && new Date(lease.expires_at) > now && result.generation === lease.generation && digest(result.token) === lease.token_digest;

        if (!leaseValid) {
          db.exec('ROLLBACK;');
          return { ok: false, error: { code: 'STALE_RESULT', message: 'lease expired, generation mismatch, or token mismatch' } };
        }

        db.prepare(
          'INSERT INTO accepted_results (attempt_id, result_id, node_id, work_id, outcome, phase, artifact_path, summary, accepted_at, generation, expected_node_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
        ).run(
          result.attempt_id,
          result.result_id,
          result.node_id,
          result.work_id,
          result.outcome,
          result.phase,
          result.artifact_path ?? null,
          result.summary ?? null,
          now.toISOString(),
          result.generation,
          result.expected_node_version,
        );
        db.prepare(
          'INSERT INTO completion_authorizations (attempt_id, node_id, work_id, result_id, expected_node_version, authorized_at) VALUES (?, ?, ?, ?, ?, ?);',
        ).run(result.attempt_id, result.node_id, result.work_id, result.result_id, node.version, now.toISOString());
        db.prepare("UPDATE attempts SET state = 'result_accepted' WHERE attempt_id = ?;").run(result.attempt_id);
        db.exec('COMMIT;');
        audit('result_accepted', { result_id: result.result_id, outcome: result.outcome, generation: result.generation, expected_node_version: result.expected_node_version }, { attemptId: result.attempt_id, workId: result.work_id, nodeId: result.node_id });
        return { ok: true };
      } catch (e) {
        db.exec('ROLLBACK;');
        return { ok: false, error: { code: 'INVALID_RESULT', message: (e as Error).message } };
      }
    },

    async getAcceptedResult(attemptId) {
      const row = db.prepare('SELECT * FROM accepted_results WHERE attempt_id = ?').get(attemptId) as WorkerResult | undefined;
      return row ?? null;
    },

    async completeAuthorizedResult(workId, nodeId, attemptId) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const auth = db.prepare('SELECT expected_node_version, result_id FROM completion_authorizations WHERE attempt_id = ?').get(attemptId) as { expected_node_version: number; result_id: string } | undefined;
        if (!auth) {
          db.exec('ROLLBACK;');
          return err('INVALID_RESULT', 'no completion authorization for attempt');
        }
        const node = db.prepare('SELECT state, version FROM nodes WHERE work_id = ? AND node_id = ?').get(workId, nodeId) as { state: NodeState; version: number } | undefined;
        if (!node) {
          db.exec('ROLLBACK;');
          return err('NODE_NOT_FOUND', 'node not found');
        }
        if (node.version !== auth.expected_node_version) {
          db.exec('ROLLBACK;');
          return err('STALE_VERSION', 'expected version mismatch');
        }
        const accepted = db.prepare('SELECT outcome FROM accepted_results WHERE attempt_id = ?').get(attemptId) as { outcome: 'passed' | 'failed' } | undefined;
        if (!accepted) {
          db.exec('ROLLBACK;');
          return err('INVALID_RESULT', 'no accepted result for attempt');
        }
        if (!isValidTransition(node.state, accepted.outcome)) {
          db.exec('ROLLBACK;');
          return err('INVALID_TRANSITION', `cannot complete from ${node.state} to ${accepted.outcome}`);
        }
        db.prepare('UPDATE nodes SET state = ?, version = version + 1 WHERE work_id = ? AND node_id = ? AND version = ?;').run(accepted.outcome, workId, nodeId, auth.expected_node_version);
        db.prepare("UPDATE attempts SET state = 'completed' WHERE attempt_id = ?;").run(attemptId);
        db.prepare('DELETE FROM completion_authorizations WHERE attempt_id = ?;').run(attemptId);
        db.exec('COMMIT;');
        audit('result_completed', { result_id: auth.result_id, expected_version: auth.expected_node_version, outcome: accepted.outcome }, { workId, nodeId, attemptId });
        return (await store.listNodes(workId)).find((n) => n.node_id === nodeId)!;
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('INVALID_RESULT', (e as Error).message);
      }
    },

    async importPredictedTouch(workId, evidence, policy) {
      const validation = validatePredictedTouchEvidence(evidence);
      if (validation) return err(validation.code, validation.message);
      if (policy.version !== evidence.policy_version) {
        return persistSchedulingDecision('optimistic', workId, evidence, policy, 'policy version mismatch', null);
      }

      const work = db.prepare('SELECT origin, approval_id, approved_head, repo, branch, frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get(workId) as {
        origin: string;
        approval_id: string | null;
        approved_head: string | null;
        repo: string;
        branch: string;
        frozen_graph_revision: string | null;
        frozen_manifest_digest: string | null;
        frozen_algorithm_version: string | null;
        frozen_policy_version: string | null;
      } | undefined;
      if (!work) return err('WORK_NOT_FOUND', 'work not found');

      const reasons: string[] = [];
      if (work.origin !== 'decomposition') reasons.push('work is not decomposed');
      if (work.approval_id !== evidence.gate1_approval_id) reasons.push('approval_id mismatch');
      if (work.approved_head !== evidence.approved_head) reasons.push('approved_head mismatch');
      if (work.repo !== evidence.repo) reasons.push('repo mismatch');

      if (reasons.length === 0 && work.frozen_graph_revision !== null) {
        if (work.frozen_graph_revision !== evidence.graph_revision) reasons.push('graph_revision mismatch');
        if (work.frozen_manifest_digest !== evidence.manifest_digest) reasons.push('manifest_digest mismatch');
        if (work.frozen_algorithm_version !== evidence.algorithm_version) reasons.push('algorithm_version mismatch');
        if (work.frozen_policy_version !== evidence.policy_version) reasons.push('policy_version mismatch');
      }

      if (reasons.length > 0) {
        return persistSchedulingDecision('optimistic', workId, evidence, policy, reasons.join('; '), null);
      }

      const nodeIds = (db.prepare('SELECT node_id FROM nodes WHERE work_id = ?').all(workId) as { node_id: string }[]).map((r) => r.node_id).sort();
      const blockers = new Map<string, string>();
      for (const overlap of evidence.classified_overlaps) {
        if (!nodeIds.includes(overlap.node_id)) continue;
        const decision = policy.classify({ nodeId: overlap.node_id, overlaps: evidence.classified_overlaps, workNodeIds: nodeIds });
        if (decision.decision === 'serialize' && decision.blocker_node_id !== overlap.node_id && nodeIds.includes(decision.blocker_node_id)) {
          blockers.set(overlap.node_id, decision.blocker_node_id);
        }
      }

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare('DELETE FROM scheduling_decisions WHERE work_id = ?').run(workId);
        const nowIso = new Date().toISOString();
        const provenance = [
          work.repo,
          work.branch,
          evidence.approved_head,
          evidence.graph_revision,
          evidence.manifest_digest,
          evidence.algorithm_version,
          evidence.policy_version,
          evidence.gate1_approval_id,
        ];
        for (const [nodeId, blockerId] of blockers) {
          db.prepare(
            `INSERT INTO scheduling_decisions
              (work_id, evidence_id, node_id, decision, blocker_node_id, reason, repo, branch, approved_head, graph_revision, manifest_digest, algorithm_version, policy_version, gate1_approval_id, classification, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          ).run(
            workId,
            evidence.evidence_id,
            nodeId,
            'serialize',
            blockerId,
            `serialized by policy ${policy.version}`,
            ...provenance,
            'high_confidence_overlap',
            nowIso,
          );
        }
        if (blockers.size === 0) {
          db.prepare(
            `INSERT INTO scheduling_decisions
              (work_id, evidence_id, node_id, decision, blocker_node_id, reason, repo, branch, approved_head, graph_revision, manifest_digest, algorithm_version, policy_version, gate1_approval_id, classification, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          ).run(
            workId,
            evidence.evidence_id,
            '',
            'optimistic',
            null,
            `no overlap under policy ${policy.version}`,
            ...provenance,
            'no_confident_overlap',
            nowIso,
          );
        }
        if (work.frozen_graph_revision === null) {
          db.prepare(
            'UPDATE works SET frozen_graph_revision = ?, frozen_manifest_digest = ?, frozen_algorithm_version = ?, frozen_policy_version = ?, frozen_evidence_id = ?, frozen_at = ? WHERE work_id = ?',
          ).run(evidence.graph_revision, evidence.manifest_digest, evidence.algorithm_version, evidence.policy_version, evidence.evidence_id, nowIso, workId);
        }
        db.exec('COMMIT;');
        const first = blockers.entries().next().value as [string, string] | undefined;
        return {
          evidence_id: evidence.evidence_id,
          work_id: workId,
          decision: (first ? 'serialize' : 'optimistic') as 'serialize' | 'optimistic',
          blocker_node_id: first ? first[1] : null,
          reason: first ? `serialized by policy ${policy.version}` : `no overlap under policy ${policy.version}`,
        };
      } catch (e) {
        db.exec('ROLLBACK;');
        return err('PREDICTED_TOUCH_INVALID', (e as Error).message);
      }

      function persistSchedulingDecision(
        decision: 'optimistic' | 'serialize',
        workId: string,
        evidence: PredictedTouchEvidence,
        policy: SchedulingPolicy,
        reason: string,
        blocker: string | null,
      ): PredictedTouchImport {
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.prepare('DELETE FROM scheduling_decisions WHERE work_id = ?').run(workId);
          const work = db.prepare('SELECT repo, branch FROM works WHERE work_id = ?').get(workId) as { repo: string; branch: string } | undefined;
          const nowIso = new Date().toISOString();
          db.prepare(
            `INSERT INTO scheduling_decisions
              (work_id, evidence_id, node_id, decision, blocker_node_id, reason, repo, branch, approved_head, graph_revision, manifest_digest, algorithm_version, policy_version, gate1_approval_id, classification, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          ).run(
            workId,
            evidence.evidence_id,
            '',
            decision,
            blocker,
            reason,
            work?.repo ?? evidence.repo,
            work?.branch ?? '',
            evidence.approved_head,
            evidence.graph_revision,
            evidence.manifest_digest,
            evidence.algorithm_version,
            evidence.policy_version,
            evidence.gate1_approval_id,
            'fallback',
            nowIso,
          );
          db.exec('COMMIT;');
        } catch (e) {
          db.exec('ROLLBACK;');
        }
        return {
          evidence_id: evidence.evidence_id,
          work_id: workId,
          decision,
          blocker_node_id: blocker,
          reason,
        };
      }
    },

    async getSchedulingBlockers(workId) {
      const rows = db.prepare('SELECT node_id, blocker_node_id FROM scheduling_decisions WHERE work_id = ? AND decision = ?').all(workId, 'serialize') as { node_id: string; blocker_node_id: string }[];
      return new Map(rows.map((r) => [r.node_id, r.blocker_node_id]));
    },

    async listAttemptsNeedingReconciliation(now) {
      const rows = db.prepare("SELECT * FROM attempts WHERE state = 'created' OR (state = 'leased' AND attempt_id IN (SELECT attempt_id FROM leases WHERE expires_at <= ?))").all(now.toISOString()) as AttemptRecord[];
      return rows;
    },

    async listAuthorizedResults() {
      return db.prepare('SELECT attempt_id, node_id, work_id, result_id, expected_node_version FROM completion_authorizations').all() as { attempt_id: string; node_id: string; work_id: string; result_id: string; expected_node_version: number }[];
    },

    async listCreatedAttempts() {
      return db.prepare('SELECT * FROM attempts WHERE state = ?').all('created') as AttemptRecord[];
    },

    async close() {
      db.close();
    },
  };

  return store;
}

function validatePredictedTouchEvidence(evidence: PredictedTouchEvidence): OrchestrationError | null {
  if (!isPlainObject(evidence)) {
    return { code: 'PREDICTED_TOUCH_INVALID', message: 'evidence must be a plain object' };
  }
  const checks: [string, string, number][] = [
    ['evidence_id', evidence.evidence_id, ORCHESTRATION_LIMITS.maxEvidenceIdLength],
    ['repo', evidence.repo, ORCHESTRATION_LIMITS.maxRepoLength],
    ['approved_head', evidence.approved_head, ORCHESTRATION_LIMITS.maxDigestLength],
    ['graph_revision', evidence.graph_revision, ORCHESTRATION_LIMITS.maxGraphRevisionLength],
    ['manifest_digest', evidence.manifest_digest, ORCHESTRATION_LIMITS.maxDigestLength],
    ['algorithm_version', evidence.algorithm_version, ORCHESTRATION_LIMITS.maxVersionLength],
    ['policy_version', evidence.policy_version, ORCHESTRATION_LIMITS.maxVersionLength],
    ['gate1_approval_id', evidence.gate1_approval_id, ORCHESTRATION_LIMITS.maxIdLength],
  ];
  for (const [name, value, max] of checks) {
    if (!hasOwnField(evidence, name)) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: `missing ${name}` };
    }
    if (!isNonEmptyString(value, max)) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: `invalid ${name}` };
    }
  }
  if (!hasOwnField(evidence, 'classified_overlaps')) {
    return { code: 'PREDICTED_TOUCH_INVALID', message: 'missing classified_overlaps' };
  }
  if (!Array.isArray(evidence.classified_overlaps) || evidence.classified_overlaps.length > ORCHESTRATION_LIMITS.maxClassifiedOverlaps) {
    return { code: 'PREDICTED_TOUCH_INVALID', message: 'invalid classified_overlaps' };
  }
  for (const overlap of evidence.classified_overlaps) {
    if (!isPlainObject(overlap)) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'overlap must be an object' };
    }
    const allowedOverlap = new Set(['node_id', 'confidence', 'likely_touched_units', 'shared_surfaces']);
    for (const key of Object.keys(overlap)) {
      if (!allowedOverlap.has(key)) {
        return { code: 'PREDICTED_TOUCH_INVALID', message: `unknown overlap field ${key}` };
      }
    }
    if (!hasOwnField(overlap, 'node_id')) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'missing overlap node_id' };
    }
    if (!isNonEmptyString(overlap.node_id, ORCHESTRATION_LIMITS.maxIdLength)) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'invalid overlap node_id' };
    }
    if (!hasOwnField(overlap, 'confidence')) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'missing confidence' };
    }
    if (typeof overlap.confidence !== 'number' || overlap.confidence < 0 || overlap.confidence > 1) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'invalid confidence' };
    }
    if (!hasOwnField(overlap, 'likely_touched_units')) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'missing likely_touched_units' };
    }
    if (!hasOwnField(overlap, 'shared_surfaces')) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'missing shared_surfaces' };
    }
    if (!Array.isArray(overlap.likely_touched_units) ||
        overlap.likely_touched_units.length > ORCHESTRATION_LIMITS.maxTouchedUnitsPerOverlap ||
        !Array.isArray(overlap.shared_surfaces) ||
        overlap.shared_surfaces.length > ORCHESTRATION_LIMITS.maxSharedSurfacesPerOverlap) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: 'invalid overlap arrays' };
    }
    for (const unit of overlap.likely_touched_units) {
      if (!isNonEmptyString(unit, ORCHESTRATION_LIMITS.maxIdLength)) {
        return { code: 'PREDICTED_TOUCH_INVALID', message: 'invalid touched unit' };
      }
    }
    for (const surface of overlap.shared_surfaces) {
      if (!isNonEmptyString(surface, ORCHESTRATION_LIMITS.maxIdLength)) {
        return { code: 'PREDICTED_TOUCH_INVALID', message: 'invalid shared surface' };
      }
    }
  }
  const allowed = new Set([
    'evidence_id', 'repo', 'approved_head', 'graph_revision', 'manifest_digest',
    'algorithm_version', 'policy_version', 'gate1_approval_id', 'classified_overlaps',
  ]);
  for (const key of Object.keys(evidence)) {
    if (!allowed.has(key)) {
      return { code: 'PREDICTED_TOUCH_INVALID', message: `unknown field ${key}` };
    }
  }
  return null;
}

function validateResult(result: WorkerResult): OrchestrationError | null {
  if (!isPlainObject(result)) return { code: 'INVALID_RESULT', message: 'result must be an object' };
  const allowed = new Set(['result_id', 'attempt_id', 'node_id', 'work_id', 'outcome', 'phase', 'token', 'generation', 'expected_node_version', 'artifact_path', 'summary']);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) return { code: 'INVALID_RESULT', message: `unknown field ${key}` };
  }
  if (!isNonEmptyString(result.result_id, ORCHESTRATION_LIMITS.maxResultIdLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid result_id' };
  }
  if (!isNonEmptyString(result.attempt_id, ORCHESTRATION_LIMITS.maxIdLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid attempt_id' };
  }
  if (!isNonEmptyString(result.node_id, ORCHESTRATION_LIMITS.maxIdLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid node_id' };
  }
  if (!isNonEmptyString(result.work_id, ORCHESTRATION_LIMITS.maxIdLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid work_id' };
  }
  if (result.outcome !== 'passed' && result.outcome !== 'failed') {
    return { code: 'INVALID_RESULT', message: 'invalid outcome' };
  }
  if (!isNonEmptyString(result.phase, ORCHESTRATION_LIMITS.maxVersionLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid phase' };
  }
  if (!isNonEmptyString(result.token, ORCHESTRATION_LIMITS.maxTokenLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid token' };
  }
  if (!isPositiveInteger(result.generation)) {
    return { code: 'INVALID_RESULT', message: 'invalid generation' };
  }
  if (!isPositiveInteger(result.expected_node_version)) {
    return { code: 'INVALID_RESULT', message: 'invalid expected_node_version' };
  }
  if (result.artifact_path !== undefined && !isNonEmptyString(result.artifact_path, ORCHESTRATION_LIMITS.maxPathLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid artifact_path' };
  }
  if (result.summary !== undefined && !isNonEmptyString(result.summary, ORCHESTRATION_LIMITS.maxSummaryLength)) {
    return { code: 'INVALID_RESULT', message: 'invalid summary' };
  }
  return null;
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  return value === null ? undefined : value;
}

function resultsEqual(a: WorkerResult, b: WorkerResult): boolean {
  return (
    a.result_id === b.result_id &&
    a.attempt_id === b.attempt_id &&
    a.node_id === b.node_id &&
    a.work_id === b.work_id &&
    a.outcome === b.outcome &&
    a.phase === b.phase &&
    a.generation === b.generation &&
    a.expected_node_version === b.expected_node_version &&
    normalizeOptional(a.artifact_path) === normalizeOptional(b.artifact_path) &&
    normalizeOptional(a.summary) === normalizeOptional(b.summary)
  );
}
