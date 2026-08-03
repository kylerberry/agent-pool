#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanComplete,
  assertCanRecordCheckpoint,
  assertCanRecordDecision,
  assertCanRecordPhase,
  boundFixTarget,
  computeFrontier,
  ensurePhaseHistory,
  FLOWS,
  hashJson,
  JOURNAL_SCHEMA_VERSION,
  latestPhase,
  nextAction,
  normalizeLedger,
  PHASES,
  SECURITY_TRIGGERS,
  validateCheckpoint,
  validateDecision,
  validatePhaseArtifact,
} from "./goal-journal.mjs";
import { validatePlan } from "./goal-plan.mjs";

const BOUNDS = {
  max_approver_length: 256,
  max_approval_context_length: 4096,
};

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail(`${label} must be a safe path segment`);
  return value;
}
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function assertNoSymlinkAncestors(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("path escapes repository root");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail(`symlinked dispatcher path is not allowed: ${current}`);
  }
}
function atomicWriteBytes(filePath, bytes, mode = 0o600) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  const directoryDescriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}
function atomicWriteJson(filePath, data) { atomicWriteBytes(filePath, Buffer.from(`${JSON.stringify(data, null, 2)}\n`), 0o600); }
function sha256File(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

class FileLock {
  constructor(lockPath) { this.lockPath = lockPath; this.descriptor = null; this.token = `${process.pid}:${crypto.randomUUID()}`; }
  acquire() {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    try {
      this.descriptor = fs.openSync(this.lockPath, "wx", 0o600);
      fs.writeFileSync(this.descriptor, `${this.token}\n`);
      fs.fsyncSync(this.descriptor);
    } catch (error) {
      if (error.code === "EEXIST") fail(`ledger lock is held at ${this.lockPath}; after confirming no dispatcher is active, remove this stale lock manually`);
      throw error;
    }
  }
  release() {
    if (this.descriptor !== null) { try { fs.closeSync(this.descriptor); } catch {} this.descriptor = null; }
    try {
      if (fs.readFileSync(this.lockPath, "utf8").trim() === this.token) fs.unlinkSync(this.lockPath);
    } catch {}
  }
}

export class GoalDispatcher {
  constructor({ rootDir = process.cwd(), runId = process.env.GOAL_RUN_ID || "default", planPath = "docs/raw/plans/proposed-build-dag.json" } = {}) {
    this.rootDir = fs.realpathSync(path.resolve(rootDir));
    this.runId = safeSegment(runId, "runId");
    const resolvedPlan = path.isAbsolute(planPath) ? path.resolve(planPath) : path.resolve(this.rootDir, planPath);
    this.planPath = fs.realpathSync(resolvedPlan);
    if (!isWithin(this.rootDir, this.planPath)) fail("plan path must be inside the repository root");
    this.ledgerBase = path.join(this.rootDir, ".pi", "goal-runs");
    this.ledgerDir = path.join(this.ledgerBase, this.runId);
    this.ledgerPath = path.join(this.ledgerDir, "ledger.json");
    this.lockPath = path.join(this.ledgerDir, "ledger.lock");
    this.workspaceGuardPath = path.join(this.ledgerBase, "workspace-writer.json");
    this.archiveDir = path.join(this.ledgerBase, ".archived");
  }

  async _withLock(operation) {
    const lock = new FileLock(this.lockPath);
    lock.acquire();
    try {
      const result = operation();
      return await result;
    } finally {
      lock.release();
    }
  }
  _withLockSync(operation) {
    const lock = new FileLock(this.lockPath);
    lock.acquire();
    try {
      return operation();
    } finally {
      lock.release();
    }
  }
  _readLedger() {
    const ledger = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8"));
    if (ledger.schema_version !== JOURNAL_SCHEMA_VERSION) {
      fail(`ledger schema v${ledger.schema_version} requires upgrade-ledger before mutating commands`);
    }
    return normalizeLedger(ledger);
  }
  _writeLedger(ledger) { ledger.updated_at = new Date().toISOString(); atomicWriteJson(this.ledgerPath, ledger); }
  _assertNoDrift(ledger) { const current = sha256File(this.planPath); if (current !== ledger.frozen_plan_sha) fail(`plan drift detected: frozen ${ledger.frozen_plan_sha}, current ${current}`); }
  _guardIdentity(nodeId, attemptId, nextActionValue = null) {
    const guard = { run_id: this.runId, node_id: nodeId, attempt_id: attemptId, workspace: this.rootDir };
    if (nextActionValue !== null) guard.next_action = nextActionValue;
    return guard;
  }
  _ensureWorkspaceGuard(nodeId, attemptId, nextActionValue = null) {
    fs.mkdirSync(this.ledgerBase, { recursive: true });
    assertNoSymlinkAncestors(this.rootDir, this.ledgerBase);
    if (fs.existsSync(this.workspaceGuardPath) && fs.lstatSync(this.workspaceGuardPath).isSymbolicLink()) fail("symlinked workspace guard is not allowed");
    try {
      const descriptor = fs.openSync(this.workspaceGuardPath, "wx", 0o600);
      try { fs.writeFileSync(descriptor, `${JSON.stringify(this._guardIdentity(nodeId, attemptId, nextActionValue))}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (fs.lstatSync(this.workspaceGuardPath).isSymbolicLink()) fail("symlinked workspace guard is not allowed");
      const existing = JSON.parse(fs.readFileSync(this.workspaceGuardPath, "utf8"));
      const identity = { run_id: existing.run_id, node_id: existing.node_id, attempt_id: existing.attempt_id, workspace: existing.workspace };
      const expectedIdentity = { run_id: this.runId, node_id: nodeId, attempt_id: attemptId, workspace: this.rootDir };
      if (canonical(identity) !== canonical(expectedIdentity)) {
        fail(`workspace already has active writer ${existing.run_id}/${existing.node_id}/${existing.attempt_id}; use a distinct git worktree`);
      }
      if (JSON.stringify(existing.next_action) !== JSON.stringify(nextActionValue)) {
        atomicWriteJson(this.workspaceGuardPath, this._guardIdentity(nodeId, attemptId, nextActionValue));
      }
      return false;
    }
  }
  _releaseWorkspaceGuard(nodeId, attemptId) {
    if (!fs.existsSync(this.workspaceGuardPath)) return;
    const expected = this._guardIdentity(nodeId, attemptId);
    const existing = JSON.parse(fs.readFileSync(this.workspaceGuardPath, "utf8"));
    const compare = { ...existing };
    delete compare.next_action;
    if (canonical(compare) === canonical(expected)) fs.unlinkSync(this.workspaceGuardPath);
  }
  _frontier(ledger) { return computeFrontier(ledger); }

  async init() {
    assertNoSymlinkAncestors(this.rootDir, this.ledgerDir);
    return this._withLock(() => {
      const { plan, sha } = validatePlan(this.planPath);
      if (fs.existsSync(this.ledgerPath)) {
        const ledger = this._readLedger();
        if (ledger.frozen_plan_sha !== sha) fail("plan drift detected on init");
        return { created: false, ledger_path: this.ledgerPath };
      }
      const nodes = Object.fromEntries(plan.nodes.map((node) => [node.id, { status: "pending", depends_on: [...node.depends_on], attempts: [] }]));
      const now = new Date().toISOString();
      this._writeLedger({ schema_version: JOURNAL_SCHEMA_VERSION, run_id: this.runId, created_at: now, updated_at: now, frozen_plan_sha: sha, plan_path: path.relative(this.rootDir, this.planPath), nodes, amendments: [] });
      return { created: true, ledger_path: this.ledgerPath };
    });
  }

  status() {
    const ledger = this._readLedger();
    const current = sha256File(this.planPath);
    return { run_id: ledger.run_id, frozen_plan_sha: ledger.frozen_plan_sha, current_plan_sha: current, planDrift: current !== ledger.frozen_plan_sha, ...this._frontier(ledger) };
  }

  resume() {
    return this._withLockSync(() => {
      const ledger = this._readLedger();
      this._assertNoDrift(ledger);
      const frontier = this._frontier(ledger);
      const nodeId = frontier.inProgress[0] || null;
      if (!nodeId) {
        const current = sha256File(this.planPath);
        return { run_id: ledger.run_id, frozen_plan_sha: ledger.frozen_plan_sha, current_plan_sha: current, planDrift: current !== ledger.frozen_plan_sha, ...frontier, active_attempt: null };
      }
      const attempt = ledger.nodes[nodeId].attempts.at(-1);
      const action = nextAction(attempt);
      this._ensureWorkspaceGuard(nodeId, attempt.attempt_id, action);
      const current = sha256File(this.planPath);
      return {
        run_id: ledger.run_id,
        frozen_plan_sha: ledger.frozen_plan_sha,
        current_plan_sha: current,
        planDrift: current !== ledger.frozen_plan_sha,
        ...frontier,
        active_attempt: { node_id: nodeId, attempt_id: attempt.attempt_id, flow: attempt.flow, next_action: action },
      };
    });
  }

  async start({ nodeId, flow = "C-R-A-F-T-S" } = {}) {
    if (!FLOWS.has(flow)) fail(`invalid flow: ${flow}`);
    return this._withLock(() => {
      const ledger = this._readLedger();
      this._assertNoDrift(ledger);
      const frontier = this._frontier(ledger);
      if (frontier.inProgress.length) {
        const activeNode = frontier.inProgress[0];
        const active = ledger.nodes[activeNode].attempts.at(-1);
        if (!nodeId || nodeId === activeNode) {
          const action = nextAction(active);
          this._ensureWorkspaceGuard(activeNode, active.attempt_id, action);
          return { node_id: activeNode, attempt_id: active.attempt_id, flow: active.flow, resumed: true };
        }
        fail(`node ${activeNode} is already in progress; explicit parallelism requires a distinct git worktree and GOAL_RUN_ID`);
      }
      const target = nodeId || frontier.ready[0];
      if (!target || !frontier.ready.includes(target)) fail(`node ${target || "<none>"} is not in the ready frontier`);
      const sequence = ledger.nodes[target].attempts.length + 1;
      const attemptId = `${target}-attempt-${sequence}`;
      const attempt = { attempt_id: attemptId, sequence, flow, started_at: new Date().toISOString(), base_git: { available: false }, phases: {}, phase_history: {}, checkpoints: [], decisions: [], final_status: null };
      ledger.nodes[target].status = "in_progress";
      ledger.nodes[target].attempts.push(attempt);
      const action = nextAction(attempt);
      this._ensureWorkspaceGuard(target, attemptId, action);
      try { this._writeLedger(ledger); } catch (error) { this._releaseWorkspaceGuard(target, attemptId); throw error; }
      return { node_id: target, attempt_id: attemptId, flow, resumed: false };
    });
  }

  async retry({ nodeId, approvedBy, reason } = {}) {
    safeSegment(nodeId, "retry node ID");
    if (typeof approvedBy !== "string" || !approvedBy.trim() || approvedBy.length > BOUNDS.max_approver_length) fail("retry approvedBy is invalid");
    if (typeof reason !== "string" || !reason.trim() || reason.length > BOUNDS.max_approval_context_length) fail("retry reason is invalid");
    return this._withLock(() => {
      const ledger = this._readLedger();
      this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId];
      if (!node) fail(`unknown plan node: ${nodeId}`);
      if (!["failed", "escalated"].includes(node.status)) fail("retry requires a failed or escalated node");
      if (Object.values(ledger.nodes).some((candidate) => candidate.status === "in_progress")) fail("retry requires no active attempt");
      if (node.depends_on.some((dependency) => ledger.nodes[dependency]?.status !== "passed")) fail("retry dependencies are not passed");
      const previous = node.attempts.at(-1);
      if (!previous?.final_status || !["failed", "escalated"].includes(previous.final_status)) fail("retry source attempt is not terminal");
      const sequence = node.attempts.length + 1;
      const attemptId = `${nodeId}-attempt-${sequence}`;
      const authorizedAt = new Date().toISOString();
      const attempt = {
        attempt_id: attemptId,
        sequence,
        flow: previous.flow,
        started_at: authorizedAt,
        base_git: { available: false },
        phases: {},
        phase_history: {},
        checkpoints: [],
        decisions: [],
        retry: { retry_of: previous.attempt_id, approved_by: approvedBy.trim(), reason: reason.trim(), authorized_at: authorizedAt },
        final_status: null,
      };
      node.status = "in_progress";
      node.attempts.push(attempt);
      const action = nextAction(attempt);
      this._ensureWorkspaceGuard(nodeId, attemptId, action);
      try { this._writeLedger(ledger); } catch (error) { this._releaseWorkspaceGuard(nodeId, attemptId); throw error; }
      return { node_id: nodeId, attempt_id: attemptId, flow: previous.flow, retry_of: previous.attempt_id, resumed: false };
    });
  }

  _recordArtifactFile(relativePath, data) {
    const fullPath = path.join(this.ledgerDir, relativePath);
    assertNoSymlinkAncestors(this.rootDir, path.dirname(fullPath));
    atomicWriteJson(fullPath, data);
  }

  async recordPhase(nodeId, attemptId, phase, artifact) {
    if (!PHASES.has(phase)) fail(`invalid phase: ${phase}`);
    const { plan } = validatePlan(this.planPath);
    const planNode = plan.nodes.find((node) => node.id === nodeId);
    if (!planNode) fail(`unknown plan node: ${nodeId}`);
    validatePhaseArtifact(artifact, { nodeId, attemptId, phase, acceptanceCriteria: planNode.acceptance_criteria });
    return this._withLock(() => {
      const ledger = this._readLedger();
      this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId];
      const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt) fail(`unknown node or attempt: ${nodeId}/${attemptId}`);
      if (node.status !== "in_progress" || attempt.final_status !== null) fail("phase artifacts can be recorded only for an active attempt");
      if (phase === "C" && artifact.phase_data.selected_flow !== attempt.flow) fail("C selected_flow does not match reserved attempt flow");
      const digest = hashJson(artifact);
      const existing = latestPhase(attempt, phase);
      if (existing?.sha256 === digest) return { path: existing.path, sha256: digest, replayed: true };
      const can = assertCanRecordPhase(attempt, phase, digest);
      ensurePhaseHistory(attempt);
      const previousRecords = [...(attempt.phase_history[phase] || [])];
      const revision = previousRecords.length + 1;
      const fileName = revision === 1 ? `${phase}.json` : `${phase}-${revision}.json`;
      const relativePath = path.join("phases", nodeId, attemptId, fileName);
      this._recordArtifactFile(relativePath, artifact);
      const record = { path: relativePath, sha256: digest, status: artifact.status, recorded_at: new Date().toISOString() };
      if (phase === "C") record.triggers = artifact.phase_data.security_triggers;
      if (phase === "F") {
        const target = boundFixTarget(attempt);
        if (target) record.bound_to = target.sha256;
      }
      attempt.phase_history[phase] = [...previousRecords, record];
      attempt.phases[phase] = record;
      const action = nextAction(attempt);
      this._writeLedger(ledger);
      if (node.status === "in_progress") this._ensureWorkspaceGuard(nodeId, attemptId, action);
      return { path: relativePath, sha256: digest, replayed: false };
    });
  }

  async recordCheckpoint(nodeId, attemptId, checkpoint) {
    return this._withLock(() => {
      const ledger = this._readLedger();
      this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId];
      const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt) fail(`unknown node or attempt: ${nodeId}/${attemptId}`);
      if (node.status !== "in_progress" || attempt.final_status !== null) fail("checkpoints can be recorded only for an active attempt");
      validateCheckpoint(checkpoint, { attempt });
      assertCanRecordCheckpoint(attempt, checkpoint);
      const digest = hashJson(checkpoint);
      const existing = attempt.checkpoints.find((item) => item.sha256 === digest);
      if (existing) return { path: existing.path, sha256: digest, replayed: true };
      const revision = attempt.checkpoints.filter((item) => item.kind === checkpoint.kind).length + 1;
      const fileName = `${checkpoint.kind}-${revision}.json`;
      const relativePath = path.join("checkpoints", nodeId, attemptId, fileName);
      this._recordArtifactFile(relativePath, checkpoint);
      const record = { ...checkpoint, path: relativePath, sha256: digest, recorded_at: new Date().toISOString() };
      attempt.checkpoints.push(record);
      const action = nextAction(attempt);
      this._writeLedger(ledger);
      if (node.status === "in_progress") this._ensureWorkspaceGuard(nodeId, attemptId, action);
      return { path: relativePath, sha256: digest, replayed: false };
    });
  }

  async recordDecision(nodeId, attemptId, decision) {
    return this._withLock(() => {
      const ledger = this._readLedger();
      this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId];
      const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt) fail(`unknown node or attempt: ${nodeId}/${attemptId}`);
      if (node.status !== "in_progress" || attempt.final_status !== null) fail("decisions can be recorded only for an active attempt");
      validateDecision(decision, { attempt });
      assertCanRecordDecision(attempt, decision.bound_to);
      const digest = hashJson(decision);
      const existing = attempt.decisions.find((item) => item.sha256 === digest);
      if (existing) return { path: existing.path, sha256: digest, replayed: true };
      const revision = attempt.decisions.length + 1;
      const fileName = `decision-${revision}.json`;
      const relativePath = path.join("decisions", nodeId, attemptId, fileName);
      this._recordArtifactFile(relativePath, decision);
      const record = { ...decision, path: relativePath, sha256: digest, recorded_at: new Date().toISOString() };
      attempt.decisions.push(record);
      const action = nextAction(attempt);
      this._writeLedger(ledger);
      if (decision.outcome === "stop-and-rescope") {
        node.status = "escalated";
        attempt.final_status = "escalated";
        attempt.completed_at = new Date().toISOString();
        ensurePhaseHistory(attempt);
        const summary = {
          schema_version: JOURNAL_SCHEMA_VERSION, node_id: nodeId, attempt_id: attemptId, status: "escalated", flow: attempt.flow,
          completed_at: attempt.completed_at, phases: attempt.phases, phase_history: attempt.phase_history, checkpoints: attempt.checkpoints, decisions: attempt.decisions,
        };
        const completionPath = path.join("nodes", nodeId, attemptId, "completion.json");
        this._recordArtifactFile(completionPath, summary);
        attempt.completion_path = completionPath;
        this._writeLedger(ledger);
        this._releaseWorkspaceGuard(nodeId, attemptId);
      } else if (node.status === "in_progress") {
        this._ensureWorkspaceGuard(nodeId, attemptId, action);
      }
      return { path: relativePath, sha256: digest, replayed: false, outcome: decision.outcome };
    });
  }

  async complete(nodeId, attemptId, status) {
    if (!["passed", "failed", "escalated"].includes(status)) fail(`invalid completion status: ${status}`);
    return this._withLock(async () => {
      const ledger = this._readLedger();
      this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId];
      const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt || node.status !== "in_progress" || attempt.final_status !== null) fail("node attempt is not active");
      if (status === "passed") {
        assertCanComplete(attempt, status);
      }
      node.status = status;
      attempt.final_status = status;
      attempt.completed_at = new Date().toISOString();
      ensurePhaseHistory(attempt);
      const summary = {
        schema_version: JOURNAL_SCHEMA_VERSION,
        node_id: nodeId,
        attempt_id: attemptId,
        status,
        flow: attempt.flow,
        completed_at: attempt.completed_at,
        phases: attempt.phases,
        phase_history: attempt.phase_history,
        checkpoints: attempt.checkpoints,
        decisions: attempt.decisions,
      };
      const relativePath = path.join("nodes", nodeId, attemptId, "completion.json");
      this._recordArtifactFile(relativePath, summary);
      attempt.completion_path = relativePath;
      this._writeLedger(ledger);
      this._releaseWorkspaceGuard(nodeId, attemptId);
      const telemetryCandidate = await this._emitCandidate(ledger, nodeId, attemptId);
      return { node_id: nodeId, attempt_id: attemptId, status, completion_path: relativePath, telemetry_candidate: telemetryCandidate };
    });
  }

  async emitCandidate(nodeId, attemptId) {
    const ledger = this._readLedger();
    this._assertNoDrift(ledger);
    const node = ledger.nodes?.[nodeId];
    const attempt = node?.attempts?.find((candidate) => candidate.attempt_id === attemptId);
    if (!attempt?.final_status) fail("candidate source attempt is not complete");
    return this._emitCandidate(ledger, nodeId, attemptId);
  }

  async _emitCandidate(ledger, nodeId, attemptId) {
    try {
      const { emitEvalCandidate } = await import("../extensions/eval-telemetry/core.mjs");
      const { plan } = validatePlan(this.planPath);
      return emitEvalCandidate({ rootDir: this.rootDir, runId: this.runId, plan, ledger, nodeId, attemptId });
    } catch (error) {
      return { status: "degraded", error_code: typeof error?.code === "string" ? error.code : "candidate_write_failed" };
    }
  }

  async upgradeLedger({ dryRun = false } = {}) {
    return this._withLock(() => {
      if (!fs.existsSync(this.ledgerPath)) fail("ledger does not exist");
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      const ledger = JSON.parse(raw);
      if (ledger.schema_version === JOURNAL_SCHEMA_VERSION) return { upgraded: false, reason: "already_v2" };
      if (ledger.schema_version !== 1) fail(`unsupported ledger schema_version: ${ledger.schema_version}`);
      validatePlan(this.planPath);
      assertNoSymlinkAncestors(this.rootDir, this.archiveDir);
      const backupName = `${crypto.createHash("sha256").update(raw).digest("hex")}.json`;
      const backupPath = path.join(this.archiveDir, backupName);
      assertNoSymlinkAncestors(this.rootDir, backupPath);
      let backupExisted = false;
      if (fs.existsSync(backupPath)) {
        const existing = fs.readFileSync(backupPath);
        if (!Buffer.from(raw).equals(existing)) fail("backup exists with different contents");
        backupExisted = true;
      }
      const upgraded = {
        schema_version: JOURNAL_SCHEMA_VERSION,
        run_id: ledger.run_id || this.runId,
        created_at: ledger.created_at,
        updated_at: new Date().toISOString(),
        frozen_plan_sha: ledger.frozen_plan_sha,
        plan_path: ledger.plan_path,
        nodes: {},
        amendments: ledger.amendments || [],
      };
      for (const [id, node] of Object.entries(ledger.nodes || {})) {
        upgraded.nodes[id] = {
          status: node.status || "pending",
          depends_on: [...(node.depends_on || [])],
          attempts: (node.attempts || []).map((attempt) => {
            const upgradedAttempt = {
              attempt_id: attempt.attempt_id,
              sequence: attempt.sequence,
              flow: attempt.flow,
              started_at: attempt.started_at,
              base_git: attempt.base_git || { available: false },
              phases: attempt.phases || {},
              phase_history: attempt.phase_history || {},
              checkpoints: [],
              decisions: [],
              final_status: attempt.final_status,
              completed_at: attempt.completed_at,
              completion_path: attempt.completion_path,
              retry: attempt.retry,
            };
            const cRecord = upgradedAttempt.phases?.C;
            if (cRecord?.path) {
              const cArtifactPath = path.join(this.ledgerDir, cRecord.path);
              if (fs.existsSync(cArtifactPath)) {
                const cArtifact = JSON.parse(fs.readFileSync(cArtifactPath, "utf8"));
                if (cArtifact.schema_version !== 1 || cArtifact.node_id !== id || cArtifact.attempt_id !== attempt.attempt_id || cArtifact.phase !== "C") {
                  fail(`legacy C artifact identity mismatch: ${id}/${attempt.attempt_id}`);
                }
                if (hashJson(cArtifact) !== cRecord.sha256) fail(`legacy C artifact digest mismatch: ${id}/${attempt.attempt_id}`);
                const declaredTriggers = cArtifact.phase_data?.security_triggers;
                const triggers = declaredTriggers === undefined && attempt.final_status !== null ? [] : declaredTriggers;
                if (!Array.isArray(triggers) || new Set(triggers).size !== triggers.length || triggers.some((trigger) => !SECURITY_TRIGGERS.has(trigger))) {
                  fail(`legacy C artifact security_triggers are invalid: ${id}/${attempt.attempt_id}`);
                }
                cRecord.triggers = [...triggers];
                for (const histRecord of upgradedAttempt.phase_history?.C || []) {
                  if (histRecord.path === cRecord.path) histRecord.triggers = triggers;
                }
              }
            }
            ensurePhaseHistory(upgradedAttempt);
            return upgradedAttempt;
          }),
        };
      }
      if (dryRun) return { upgraded: true, dry_run: true, backup_path: backupPath, changes: ["schema_version 1 -> 2", "normalize attempts", "add checkpoints/decisions arrays", "recover C security triggers"] };
      fs.mkdirSync(this.archiveDir, { recursive: true });
      assertNoSymlinkAncestors(this.rootDir, backupPath);
      if (!backupExisted) atomicWriteBytes(backupPath, Buffer.from(raw), 0o600);
      this._writeLedger(upgraded);
      return { upgraded: true, dry_run: false, backup_path: backupPath, backup_existed: backupExisted };
    });
  }

  async archiveReset({ confirmationHash, approvedBy, reason } = {}) {
    if (typeof confirmationHash !== "string" || !/^[0-9a-f]{64}$/.test(confirmationHash)) fail("confirmationHash must be the current approved plan SHA-256");
    if (typeof approvedBy !== "string" || !approvedBy.trim() || approvedBy.length > BOUNDS.max_approver_length) fail("approvedBy is invalid");
    if (typeof reason !== "string" || !reason.trim() || reason.length > BOUNDS.max_approval_context_length) fail("reason is invalid");
    return this._withLock(() => {
      const ledger = this._readLedger();
      const { plan, sha } = validatePlan(this.planPath);
      if (sha !== confirmationHash) fail("confirmation hash does not match current approved plan SHA");
      const frontier = this._frontier(ledger);
      if (frontier.inProgress.length) {
        const activeNode = frontier.inProgress[0];
        const active = ledger.nodes[activeNode].attempts.at(-1);
        fail(`active attempt in progress: ${activeNode}/${active.attempt_id}; terminate or escalate before reset`);
      }
      assertNoSymlinkAncestors(this.rootDir, this.archiveDir);
      fs.mkdirSync(this.archiveDir, { recursive: true });
      const archiveName = `${this.runId}-${Date.now()}-${crypto.randomUUID()}`;
      const archivePath = path.join(this.archiveDir, archiveName);
      assertNoSymlinkAncestors(this.rootDir, archivePath);
      fs.cpSync(this.ledgerDir, archivePath, { recursive: true });
      fs.rmSync(this.ledgerDir, { recursive: true, force: true });
      const nodes = Object.fromEntries(plan.nodes.map((node) => [node.id, { status: "pending", depends_on: [...node.depends_on], attempts: [] }]));
      const now = new Date().toISOString();
      this._writeLedger({
        schema_version: JOURNAL_SCHEMA_VERSION,
        run_id: this.runId,
        created_at: now,
        updated_at: now,
        frozen_plan_sha: sha,
        plan_path: path.relative(this.rootDir, this.planPath),
        nodes,
        amendments: [],
        reset_from: {
          archived_to: path.relative(this.rootDir, archivePath),
          previous_plan_sha: ledger.frozen_plan_sha,
          approved_by: approvedBy.trim(),
          reason: reason.trim(),
          reset_at: now,
        },
      });
      return { archived_to: archivePath, reset: true };
    });
  }
}

function readIncomingArtifact(dispatcher, artifactPath) {
  const resolved = fs.realpathSync(path.resolve(artifactPath));
  const ledgerDir = fs.realpathSync(dispatcher.ledgerDir);
  if (!isWithin(ledgerDir, resolved) || fs.lstatSync(path.resolve(artifactPath)).isSymbolicLink()) {
    fail(`artifact path must be a non-symlinked file under ${dispatcher.ledgerDir}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

async function main(argv) {
  const dispatcher = new GoalDispatcher();
  const command = argv[2];
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  try {
    if (command === "init") print(await dispatcher.init());
    else if (command === "status") print(dispatcher.status());
    else if (command === "resume") print(dispatcher.resume());
    else if (command === "start") print(await dispatcher.start({ nodeId: argv[3] || undefined, flow: argv[4] || "C-R-A-F-T-S" }));
    else if (command === "retry") {
      const [nodeId, approvedBy, ...reasonParts] = argv.slice(3);
      const reason = reasonParts.join(" ");
      if (!reason) fail("usage: retry <node> <approved-by> <reason>");
      print(await dispatcher.retry({ nodeId, approvedBy, reason }));
    }
    else if (command === "record-phase") {
      const [nodeId, attemptId, phase, artifactPath] = argv.slice(3);
      if (!artifactPath) fail("usage: record-phase <node> <attempt> <phase> <artifact.json>");
      print(await dispatcher.recordPhase(nodeId, attemptId, phase, readIncomingArtifact(dispatcher, artifactPath)));
    }
    else if (command === "record-checkpoint") {
      const [nodeId, attemptId, checkpointPath] = argv.slice(3);
      if (!checkpointPath) fail("usage: record-checkpoint <node> <attempt> <checkpoint.json>");
      print(await dispatcher.recordCheckpoint(nodeId, attemptId, readIncomingArtifact(dispatcher, checkpointPath)));
    }
    else if (command === "record-decision") {
      const [nodeId, attemptId, decisionPath] = argv.slice(3);
      if (!decisionPath) fail("usage: record-decision <node> <attempt> <decision.json>");
      print(await dispatcher.recordDecision(nodeId, attemptId, readIncomingArtifact(dispatcher, decisionPath)));
    }
    else if (command === "complete") {
      const [nodeId, attemptId, status] = argv.slice(3);
      if (!status) fail("usage: complete <node> <attempt> <passed|failed|escalated>");
      print(await dispatcher.complete(nodeId, attemptId, status));
    }
    else if (command === "emit-candidate") {
      const [nodeId, attemptId] = argv.slice(3);
      if (!attemptId) fail("usage: emit-candidate <node> <attempt>");
      print(await dispatcher.emitCandidate(nodeId, attemptId));
    }
    else if (command === "upgrade-ledger") {
      print(await dispatcher.upgradeLedger({ dryRun: argv[3] === "--dry-run" }));
    }
    else if (command === "archive-reset") {
      const [confirmationHash, approvedBy, ...reasonParts] = argv.slice(3);
      const reason = reasonParts.join(" ");
      if (!reason) fail("usage: archive-reset <confirmation-hash> <approved-by> <reason>");
      print(await dispatcher.archiveReset({ confirmationHash, approvedBy, reason }));
    }
    else fail("usage: goal-dispatcher.mjs <init|status|resume|start|retry|record-phase|record-checkpoint|record-decision|complete|emit-candidate|upgrade-ledger|archive-reset>");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv);
