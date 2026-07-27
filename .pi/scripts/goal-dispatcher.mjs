#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitEvalCandidate, gitSnapshot } from "../extensions/eval-telemetry/core.mjs";

const PHASES = new Set(["C", "R", "A", "F", "T", "S"]);
const ARTIFACT_STATUSES = new Set(["passed", "needs_fix", "failed", "blocked"]);
const FLOWS = new Set(["C-R-A-F-T-S", "R-S"]);
const TOP_LEVEL_KEYS = [
  "schema_version", "node_id", "attempt_id", "phase", "status", "model",
  "started_at", "completed_at", "summary", "acceptance_criteria_status",
  "changed_files", "commands_run", "cost", "risks", "open_questions",
  "recommended_next_step", "failure_context", "transcript_path", "phase_data",
];

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys, label) {
  if (!isObject(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    fail(`${label} has missing or unknown fields`);
  }
}
function stringArray(value, label, { unique = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label} must be a string array`);
  if (unique && new Set(value).size !== value.length) fail(`${label} must contain unique values`);
}
function validDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`${label} must be a date-time`);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sha256File(filePath) { return sha256(fs.readFileSync(filePath)); }
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

function atomicWriteJson(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  const directoryDescriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}

function validateEvidence(value, label) {
  const keys = ["commit_sha", "suite_path", "suite_hash", "command", "exit_code", "image_digest", "output_artifact"];
  exactKeys(value, keys, label);
  for (const key of ["commit_sha", "suite_path", "suite_hash", "command", "image_digest", "output_artifact"]) {
    if (typeof value[key] !== "string" || !value[key]) fail(`${label}.${key} must be a non-empty string`);
  }
  if (!Number.isInteger(value.exit_code)) fail(`${label}.exit_code must be an integer`);
}
function validateFindings(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  for (const finding of value) {
    exactKeys(finding, ["severity", "message", "evidence"], `${label} finding`);
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) fail(`${label} severity is invalid`);
    if (typeof finding.message !== "string") fail(`${label} message must be a string`);
    stringArray(finding.evidence, `${label} evidence`);
  }
}
function validatePhaseData(artifact) {
  const data = artifact.phase_data;
  if (!isObject(data)) fail("phase_data must be an object");
  if (artifact.phase === "C") {
    const keys = ["complexity", "selected_flow", "scope", "non_goals", "test_strategy", "planned_files", "trust_boundaries", "render_plan"];
    exactKeys(data, keys, "C phase_data");
    if (!["lite", "full"].includes(data.complexity) || !FLOWS.has(data.selected_flow)) fail("C complexity or selected_flow is invalid");
    if (typeof data.scope !== "string") fail("C scope must be a string");
    for (const key of ["non_goals", "test_strategy", "planned_files", "trust_boundaries", "render_plan"]) stringArray(data[key], `C ${key}`);
  } else if (artifact.phase === "R") {
    exactKeys(data, ["red_evidence", "green_evidence", "implementation_notes", "patch_path"], "R phase_data");
    validateEvidence(data.red_evidence, "R red_evidence");
    validateEvidence(data.green_evidence, "R green_evidence");
    stringArray(data.implementation_notes, "R implementation_notes");
    if (data.patch_path !== null && typeof data.patch_path !== "string") fail("R patch_path must be string or null");
  } else if (artifact.phase === "A") {
    exactKeys(data, ["criteria_fit", "maintainability", "blocking_findings", "non_blocking_observations"], "A phase_data");
    exactKeys(data.criteria_fit, ["passed", "rationale"], "A criteria_fit");
    if (typeof data.criteria_fit.passed !== "boolean" || typeof data.criteria_fit.rationale !== "string") fail("A criteria_fit is invalid");
    const scores = ["correctness_risk", "locality_simplicity", "interface_clarity", "type_error_safety", "test_quality"];
    exactKeys(data.maintainability, scores, "A maintainability");
    for (const key of scores) {
      exactKeys(data.maintainability[key], ["score", "rationale"], `A ${key}`);
      if (!Number.isInteger(data.maintainability[key].score) || data.maintainability[key].score < 0 || data.maintainability[key].score > 4 || typeof data.maintainability[key].rationale !== "string") fail(`A ${key} score or rationale is invalid`);
    }
    validateFindings(data.blocking_findings, "A blocking_findings");
    stringArray(data.non_blocking_observations, "A non_blocking_observations");
  } else if (artifact.phase === "F") {
    exactKeys(data, ["findings_addressed", "documented_disagreements", "green_evidence", "patch_path"], "F phase_data");
    stringArray(data.findings_addressed, "F findings_addressed");
    stringArray(data.documented_disagreements, "F documented_disagreements");
    validateEvidence(data.green_evidence, "F green_evidence");
    if (data.patch_path !== null && typeof data.patch_path !== "string") fail("F patch_path must be string or null");
  } else if (artifact.phase === "T") {
    exactKeys(data, ["trust_boundaries_reviewed", "security_findings", "security_commands", "residual_risk"], "T phase_data");
    stringArray(data.trust_boundaries_reviewed, "T trust_boundaries_reviewed");
    validateFindings(data.security_findings, "T security_findings");
    stringArray(data.security_commands, "T security_commands");
    stringArray(data.residual_risk, "T residual_risk");
  } else if (artifact.phase === "S") {
    exactKeys(data, ["docs_changed", "domain_instructions_changed", "wiki_pages_changed", "durable_learnings"], "S phase_data");
    for (const key of ["docs_changed", "domain_instructions_changed", "wiki_pages_changed", "durable_learnings"]) stringArray(data[key], `S ${key}`);
  }
}

export function validatePhaseArtifact(artifact, { nodeId, attemptId, phase, acceptanceCriteria }) {
  exactKeys(artifact, TOP_LEVEL_KEYS, "phase artifact");
  if (artifact.schema_version !== 1 || artifact.node_id !== nodeId || artifact.attempt_id !== attemptId || artifact.phase !== phase) {
    fail("phase artifact identity does not match ledger operation");
  }
  if (!PHASES.has(artifact.phase) || !ARTIFACT_STATUSES.has(artifact.status)) fail("phase artifact phase or status is invalid");
  if (typeof artifact.model !== "string" || !/^[^/]+\/.+$/.test(artifact.model)) fail("phase artifact model is invalid");
  validDate(artifact.started_at, "started_at"); validDate(artifact.completed_at, "completed_at");
  if (typeof artifact.summary !== "string" || typeof artifact.recommended_next_step !== "string") fail("phase artifact summary fields are invalid");
  if (!Array.isArray(artifact.acceptance_criteria_status) || artifact.acceptance_criteria_status.length === 0) fail("acceptance_criteria_status must be a non-empty array");
  for (const item of artifact.acceptance_criteria_status) {
    exactKeys(item, ["criterion", "status", "evidence"], "acceptance criterion status");
    if (typeof item.criterion !== "string" || !["met", "unmet", "unknown", "not_tested"].includes(item.status)) fail("acceptance criterion status is invalid");
    stringArray(item.evidence, "acceptance criterion evidence");
  }
  if (acceptanceCriteria && JSON.stringify(artifact.acceptance_criteria_status.map((item) => item.criterion)) !== JSON.stringify(acceptanceCriteria)) {
    fail("acceptance_criteria_status must map every original criterion exactly once in source order");
  }
  stringArray(artifact.changed_files, "changed_files", { unique: true }); stringArray(artifact.risks, "risks"); stringArray(artifact.open_questions, "open_questions");
  if (["C", "A", "T"].includes(artifact.phase) && artifact.changed_files.length) fail(`${artifact.phase} must be read-only`);
  if (!Array.isArray(artifact.commands_run)) fail("commands_run must be an array");
  for (const command of artifact.commands_run) {
    exactKeys(command, ["command", "exit_code", "output_artifact"], "command evidence");
    if (typeof command.command !== "string" || !Number.isInteger(command.exit_code) || (command.output_artifact !== null && typeof command.output_artifact !== "string")) fail("command evidence is invalid");
  }
  exactKeys(artifact.cost, ["input_tokens", "output_tokens", "amount", "currency"], "cost");
  if (!Number.isInteger(artifact.cost.input_tokens) || artifact.cost.input_tokens < 0 || !Number.isInteger(artifact.cost.output_tokens) || artifact.cost.output_tokens < 0) fail("cost token counts are invalid");
  if (artifact.cost.amount !== null && (typeof artifact.cost.amount !== "number" || artifact.cost.amount < 0)) fail("cost amount is invalid");
  if (artifact.cost.currency !== null && typeof artifact.cost.currency !== "string") fail("cost currency is invalid");
  if (artifact.status === "passed" && artifact.failure_context !== null) fail("passed artifact failure_context must be null");
  if (artifact.status !== "passed") {
    exactKeys(artifact.failure_context, ["attempted", "failure_reason", "discoveries", "dead_ends"], "failure_context");
    stringArray(artifact.failure_context.attempted, "failure_context attempted");
    stringArray(artifact.failure_context.discoveries, "failure_context discoveries");
    stringArray(artifact.failure_context.dead_ends, "failure_context dead_ends");
    if (typeof artifact.failure_context.failure_reason !== "string") fail("failure_context failure_reason must be a string");
  }
  if (artifact.transcript_path !== null && typeof artifact.transcript_path !== "string") fail("transcript_path must be string or null");
  validatePhaseData(artifact);
  return artifact;
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

function nextPhase(attempt) {
  const phases = attempt.phases;
  if (attempt.flow === "R-S") return !phases.R ? "R" : !phases.S ? "S" : null;
  if (!phases.C) return "C";
  if (!phases.R) return "R";
  if (!phases.A) return "A";
  if (phases.A.status === "needs_fix" && !phases.F) return "F";
  if (!phases.T) return "T";
  if (!phases.S) return "S";
  return null;
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
    this.incomingDir = path.join(this.ledgerDir, "incoming");
  }
  static validatePlan(planPath) {
    if (!fs.existsSync(planPath)) fail(`plan not found: ${planPath}`);
    const raw = fs.readFileSync(planPath);
    let plan;
    try { plan = JSON.parse(raw); } catch (error) { fail(`plan JSON parse error: ${error.message}`); }
    if (!Array.isArray(plan.nodes) || !plan.nodes.length || !plan.approval?.approved_by || Number.isNaN(Date.parse(plan.approval?.approved_at))) fail("plan nodes or approval are invalid");
    const required = ["id", "intent", "change_spec", "acceptance_criteria", "depends_on"];
    const ids = new Set();
    for (const node of plan.nodes) {
      exactKeys(node, required, `plan node ${node.id || "<unknown>"}`);
      safeSegment(node.id, "plan node ID");
      if (ids.has(node.id)) fail(`plan node ID is duplicated: ${node.id}`);
      ids.add(node.id);
      if (typeof node.intent !== "string" || typeof node.change_spec !== "string") fail(`plan node ${node.id} contract is invalid`);
      stringArray(node.acceptance_criteria, `plan node ${node.id} acceptance_criteria`); stringArray(node.depends_on, `plan node ${node.id} depends_on`);
    }
    const incoming = new Map(plan.nodes.map((node) => [node.id, new Set(node.depends_on)]));
    for (const [id, dependencies] of incoming) for (const dependency of dependencies) {
      if (dependency === id || !ids.has(dependency)) fail(`plan node ${id} has invalid dependency ${dependency}`);
    }
    const ready = [...incoming].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    const visited = [];
    while (ready.length) {
      const id = ready.shift(); visited.push(id);
      for (const [candidate, dependencies] of incoming) if (dependencies.delete(id) && dependencies.size === 0 && !visited.includes(candidate) && !ready.includes(candidate)) ready.push(candidate);
    }
    if (visited.length !== plan.nodes.length) fail("plan contains a cycle or has no root");
    return { plan, sha: sha256(raw) };
  }
  _withLock(operation) { const lock = new FileLock(this.lockPath); lock.acquire(); try { return operation(); } finally { lock.release(); } }
  _readLedger() { return JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")); }
  _writeLedger(ledger) { ledger.updated_at = new Date().toISOString(); atomicWriteJson(this.ledgerPath, ledger); }
  _assertNoDrift(ledger) { const current = sha256File(this.planPath); if (current !== ledger.frozen_plan_sha) fail(`plan drift detected: frozen ${ledger.frozen_plan_sha}, current ${current}`); }
  _guardIdentity(nodeId, attemptId) { return { run_id: this.runId, node_id: nodeId, attempt_id: attemptId, workspace: this.rootDir }; }
  _ensureWorkspaceGuard(nodeId, attemptId) {
    const expected = this._guardIdentity(nodeId, attemptId);
    fs.mkdirSync(this.ledgerBase, { recursive: true });
    assertNoSymlinkAncestors(this.rootDir, this.ledgerBase);
    if (fs.existsSync(this.workspaceGuardPath) && fs.lstatSync(this.workspaceGuardPath).isSymbolicLink()) fail("symlinked workspace guard is not allowed");
    try {
      const descriptor = fs.openSync(this.workspaceGuardPath, "wx", 0o600);
      try { fs.writeFileSync(descriptor, `${JSON.stringify(expected)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (fs.lstatSync(this.workspaceGuardPath).isSymbolicLink()) fail("symlinked workspace guard is not allowed");
      const existing = JSON.parse(fs.readFileSync(this.workspaceGuardPath, "utf8"));
      if (canonical(existing) === canonical(expected)) return false;
      fail(`workspace already has active writer ${existing.run_id}/${existing.node_id}/${existing.attempt_id}; use a distinct git worktree`);
    }
  }
  _releaseWorkspaceGuard(nodeId, attemptId) {
    if (!fs.existsSync(this.workspaceGuardPath)) return;
    const expected = this._guardIdentity(nodeId, attemptId);
    const existing = JSON.parse(fs.readFileSync(this.workspaceGuardPath, "utf8"));
    if (canonical(existing) === canonical(expected)) fs.unlinkSync(this.workspaceGuardPath);
  }
  _frontier(ledger) {
    const effective = Object.fromEntries(Object.entries(ledger.nodes).map(([id, node]) => [id, node.status]));
    let changed = true;
    while (changed) { changed = false; for (const [id, node] of Object.entries(ledger.nodes)) if (effective[id] === "pending" && node.depends_on.some((dependency) => ["failed", "blocked", "escalated"].includes(effective[dependency]))) { effective[id] = "blocked"; changed = true; } }
    const result = { ready: [], pending: [], inProgress: [], completed: [], failed: [], blocked: [] };
    for (const [id, node] of Object.entries(ledger.nodes)) {
      const status = effective[id];
      if (status === "in_progress") result.inProgress.push(id);
      else if (status === "passed") result.completed.push(id);
      else if (status === "failed" || status === "escalated") result.failed.push(id);
      else if (status === "blocked") result.blocked.push(id);
      else if (node.depends_on.every((dependency) => effective[dependency] === "passed")) result.ready.push(id);
      else result.pending.push(id);
    }
    for (const values of Object.values(result)) values.sort();
    return result;
  }
  init() {
    assertNoSymlinkAncestors(this.rootDir, this.ledgerDir);
    fs.mkdirSync(this.incomingDir, { recursive: true });
    assertNoSymlinkAncestors(this.rootDir, this.ledgerDir);
    return this._withLock(() => {
      const { plan, sha } = GoalDispatcher.validatePlan(this.planPath);
      if (fs.existsSync(this.ledgerPath)) { const ledger = this._readLedger(); if (ledger.frozen_plan_sha !== sha) fail("plan drift detected on init"); return { created: false, ledger_path: this.ledgerPath }; }
      const nodes = Object.fromEntries(plan.nodes.map((node) => [node.id, { status: "pending", depends_on: [...node.depends_on], attempts: [] }]));
      const now = new Date().toISOString();
      this._writeLedger({ schema_version: 1, run_id: this.runId, created_at: now, updated_at: now, frozen_plan_sha: sha, plan_path: path.relative(this.rootDir, this.planPath), nodes });
      return { created: true, ledger_path: this.ledgerPath };
    });
  }
  status() {
    const ledger = this._readLedger(); const current = sha256File(this.planPath);
    return { run_id: ledger.run_id, frozen_plan_sha: ledger.frozen_plan_sha, current_plan_sha: current, planDrift: current !== ledger.frozen_plan_sha, ...this._frontier(ledger) };
  }
  resume() {
    const ledger = this._readLedger(); this._assertNoDrift(ledger); const frontier = this._frontier(ledger);
    const nodeId = frontier.inProgress[0] || null;
    if (!nodeId) return { ...this.status(), active_attempt: null };
    const attempt = ledger.nodes[nodeId].attempts.at(-1);
    this._ensureWorkspaceGuard(nodeId, attempt.attempt_id);
    return { ...this.status(), active_attempt: { node_id: nodeId, attempt_id: attempt.attempt_id, flow: attempt.flow, next_phase: nextPhase(attempt) } };
  }
  start({ nodeId, flow = "C-R-A-F-T-S" } = {}) {
    if (!FLOWS.has(flow)) fail(`invalid flow: ${flow}`);
    return this._withLock(() => {
      const ledger = this._readLedger(); this._assertNoDrift(ledger); const frontier = this._frontier(ledger);
      if (frontier.inProgress.length) {
        const activeNode = frontier.inProgress[0]; const active = ledger.nodes[activeNode].attempts.at(-1);
        if (!nodeId || nodeId === activeNode) { this._ensureWorkspaceGuard(activeNode, active.attempt_id); return { node_id: activeNode, attempt_id: active.attempt_id, flow: active.flow, resumed: true }; }
        fail(`node ${activeNode} is already in progress; explicit parallelism requires a distinct git worktree and GOAL_RUN_ID`);
      }
      const target = nodeId || frontier.ready[0];
      if (!target || !frontier.ready.includes(target)) fail(`node ${target || "<none>"} is not in the ready frontier`);
      const sequence = ledger.nodes[target].attempts.length + 1;
      const attemptId = `${target}-attempt-${sequence}`;
      this._ensureWorkspaceGuard(target, attemptId);
      ledger.nodes[target].status = "in_progress";
      ledger.nodes[target].attempts.push({ attempt_id: attemptId, sequence, flow, started_at: new Date().toISOString(), base_git: gitSnapshot(this.rootDir), phases: {}, final_status: null });
      try { this._writeLedger(ledger); } catch (error) { this._releaseWorkspaceGuard(target, attemptId); throw error; }
      return { node_id: target, attempt_id: attemptId, flow, resumed: false };
    });
  }
  recordPhase(nodeId, attemptId, phase, artifact) {
    if (!PHASES.has(phase)) fail(`invalid phase: ${phase}`);
    const { plan } = GoalDispatcher.validatePlan(this.planPath);
    const planNode = plan.nodes.find((node) => node.id === nodeId);
    if (!planNode) fail(`unknown plan node: ${nodeId}`);
    validatePhaseArtifact(artifact, { nodeId, attemptId, phase, acceptanceCriteria: planNode.acceptance_criteria });
    return this._withLock(() => {
      const ledger = this._readLedger(); this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId]; const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt) fail(`unknown node or attempt: ${nodeId}/${attemptId}`);
      if (node.status !== "in_progress" || attempt.final_status !== null) fail("phase artifacts can be recorded only for an active attempt");
      const digest = sha256(canonical(artifact));
      const existing = attempt.phases[phase];
      if (existing) { if (existing.sha256 === digest) return { path: existing.path, sha256: digest, replayed: true }; fail(`conflicting replay for phase ${phase}`); }
      const expected = nextPhase(attempt);
      if (expected !== phase) fail(`phase order violation: expected ${expected}, got ${phase}`);
      if (phase === "C" && artifact.phase_data.selected_flow !== attempt.flow) fail("C selected_flow does not match reserved attempt flow");
      const relativePath = path.join("phases", nodeId, attemptId, `${phase}.json`);
      assertNoSymlinkAncestors(this.rootDir, path.dirname(path.join(this.ledgerDir, relativePath)));
      atomicWriteJson(path.join(this.ledgerDir, relativePath), artifact);
      attempt.phases[phase] = { path: relativePath, sha256: digest, status: artifact.status, recorded_at: new Date().toISOString() };
      this._writeLedger(ledger);
      return { path: relativePath, sha256: digest, replayed: false };
    });
  }
  complete(nodeId, attemptId, status) {
    if (!["passed", "failed", "escalated"].includes(status)) fail(`invalid completion status: ${status}`);
    return this._withLock(() => {
      const ledger = this._readLedger(); this._assertNoDrift(ledger);
      const node = ledger.nodes[nodeId]; const attempt = node?.attempts.find((item) => item.attempt_id === attemptId);
      if (!attempt || node.status !== "in_progress" || attempt.final_status !== null) fail("node attempt is not active");
      if (status === "passed") {
        if (nextPhase(attempt) !== null) fail(`cannot pass incomplete attempt; next phase is ${nextPhase(attempt)}`);
        for (const [phase, record] of Object.entries(attempt.phases)) {
          if (phase === "A" && record.status === "needs_fix" && attempt.phases.F?.status === "passed") continue;
          if (record.status !== "passed") fail(`cannot pass attempt with non-passing phase ${phase}`);
        }
      }
      node.status = status; attempt.final_status = status; attempt.completed_at = new Date().toISOString();
      const summary = { schema_version: 1, node_id: nodeId, attempt_id: attemptId, status, flow: attempt.flow, completed_at: attempt.completed_at, phases: attempt.phases };
      const relativePath = path.join("nodes", nodeId, attemptId, "completion.json");
      assertNoSymlinkAncestors(this.rootDir, path.dirname(path.join(this.ledgerDir, relativePath)));
      atomicWriteJson(path.join(this.ledgerDir, relativePath), summary); attempt.completion_path = relativePath;
      this._writeLedger(ledger);
      this._releaseWorkspaceGuard(nodeId, attemptId);
      let telemetryCandidate;
      try {
        const { plan } = GoalDispatcher.validatePlan(this.planPath);
        telemetryCandidate = emitEvalCandidate({ rootDir: this.rootDir, runId: this.runId, plan, ledger, nodeId, attemptId });
      } catch (error) {
        telemetryCandidate = { status: "degraded", error_code: typeof error?.code === "string" ? error.code : "candidate_write_failed" };
      }
      return { node_id: nodeId, attempt_id: attemptId, status, completion_path: relativePath, telemetry_candidate: telemetryCandidate };
    });
  }
  emitCandidate(nodeId, attemptId) {
    const ledger = this._readLedger();
    this._assertNoDrift(ledger);
    const node = ledger.nodes?.[nodeId];
    const attempt = node?.attempts?.find((candidate) => candidate.attempt_id === attemptId);
    if (!attempt?.final_status) fail("candidate source attempt is not complete");
    const { plan } = GoalDispatcher.validatePlan(this.planPath);
    return emitEvalCandidate({ rootDir: this.rootDir, runId: this.runId, plan, ledger, nodeId, attemptId });
  }
}

function readIncomingArtifact(dispatcher, artifactPath) {
  const resolved = fs.realpathSync(path.resolve(artifactPath));
  const incoming = fs.realpathSync(dispatcher.incomingDir);
  if (!isWithin(incoming, resolved) || fs.lstatSync(path.resolve(artifactPath)).isSymbolicLink()) {
    fail(`artifact path must be a non-symlinked file under ${dispatcher.incomingDir}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function main(argv) {
  const dispatcher = new GoalDispatcher(); const command = argv[2]; const print = (value) => console.log(JSON.stringify(value, null, 2));
  try {
    if (command === "init") print(dispatcher.init());
    else if (command === "status") print(dispatcher.status());
    else if (command === "resume") print(dispatcher.resume());
    else if (command === "start") print(dispatcher.start({ nodeId: argv[3] || undefined, flow: argv[4] || "C-R-A-F-T-S" }));
    else if (command === "record-phase") { const [nodeId, attemptId, phase, artifactPath] = argv.slice(3); if (!artifactPath) fail("usage: record-phase <node> <attempt> <phase> <artifact.json>"); print(dispatcher.recordPhase(nodeId, attemptId, phase, readIncomingArtifact(dispatcher, artifactPath))); }
    else if (command === "complete") { const [nodeId, attemptId, status] = argv.slice(3); if (!status) fail("usage: complete <node> <attempt> <passed|failed|escalated>"); print(dispatcher.complete(nodeId, attemptId, status)); }
    else if (command === "emit-candidate") { const [nodeId, attemptId] = argv.slice(3); if (!attemptId) fail("usage: emit-candidate <node> <attempt>"); print(dispatcher.emitCandidate(nodeId, attemptId)); }
    else fail("usage: goal-dispatcher.mjs <init|status|resume|start|record-phase|complete|emit-candidate>");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv);
