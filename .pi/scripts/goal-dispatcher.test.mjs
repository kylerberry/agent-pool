import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GoalDispatcher } from "./goal-dispatcher.mjs";

const CLOCK_SKEW_MS = 5 * 60 * 1000;

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function makePlan(root, { approvedAt } = {}) {
  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify({
    schema_version: 1,
    nodes: [
      { id: "a", intent: "A", change_spec: "Do A", acceptance_criteria: ["A works"], depends_on: [] },
      { id: "b", intent: "B", change_spec: "Do B", acceptance_criteria: ["B works"], depends_on: ["a"] },
      { id: "c", intent: "C", change_spec: "Do C", acceptance_criteria: ["C works"], depends_on: ["a"] },
    ],
    approval: { approved_by: "test", approved_at: approvedAt || new Date(Date.now() - 60_000).toISOString() },
  }, null, 2));
  return planPath;
}
const evidence = () => ({ commit_sha: "abc", suite_path: "test", suite_hash: "hash", command: "test", exit_code: 0, image_digest: "local", output_artifact: "output" });
const scores = () => Object.fromEntries(["correctness_risk", "locality_simplicity", "interface_clarity", "type_error_safety", "test_quality"].map((key) => [key, { score: 3, rationale: key }]));
function phaseData(phase, flow = "C-R-A-F-T-S") {
  if (phase === "C") return { complexity: "full", selected_flow: flow, scope: "scope", non_goals: [], test_strategy: ["test"], planned_files: ["file"], trust_boundaries: [], security_triggers: [], render_plan: ["render"] };
  if (phase === "R") return { red_evidence: evidence(), green_evidence: evidence(), implementation_notes: [], patch_path: null };
  if (phase === "A") return { criteria_fit: { passed: true, rationale: "fit" }, maintainability: scores(), blocking_findings: [], non_blocking_observations: [] };
  if (phase === "F") return { findings_addressed: [], documented_disagreements: [], green_evidence: evidence(), patch_path: null };
  if (phase === "T") return { trust_boundaries_reviewed: [], security_findings: [], security_commands: [], residual_risk: [] };
  return { docs_changed: [], domain_instructions_changed: [], wiki_pages_changed: [], durable_learnings: [] };
}
function artifact(phase, nodeId, attemptId, { status = "passed", flow = "C-R-A-F-T-S", criterion = "A works" } = {}) {
  return {
    schema_version: 1, node_id: nodeId, attempt_id: attemptId, phase, status,
    model: "test/model", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), summary: "artifact",
    acceptance_criteria_status: [{ criterion, status: status === "passed" ? "met" : "unmet", evidence: [] }],
    changed_files: ["file"].filter(() => !["C", "A", "T"].includes(phase)), commands_run: [],
    cost: { input_tokens: 0, output_tokens: 0, amount: null, currency: null }, risks: [], open_questions: [],
    recommended_next_step: "next", failure_context: status === "passed" ? null : { attempted: [], failure_reason: "fix", discoveries: [], dead_ends: [] },
    transcript_path: null, phase_data: phaseData(phase, flow),
  };
}
function recordFull(dispatcher, nodeId, attemptId, { assessmentStatus = "passed" } = {}) {
  dispatcher.recordPhase(nodeId, attemptId, "C", artifact("C", nodeId, attemptId));
  dispatcher.recordPhase(nodeId, attemptId, "R", artifact("R", nodeId, attemptId));
  dispatcher.recordPhase(nodeId, attemptId, "A", artifact("A", nodeId, attemptId, { status: assessmentStatus }));
  if (assessmentStatus === "needs_fix") dispatcher.recordPhase(nodeId, attemptId, "F", artifact("F", nodeId, attemptId));
  dispatcher.recordPhase(nodeId, attemptId, "T", artifact("T", nodeId, attemptId));
  dispatcher.recordPhase(nodeId, attemptId, "S", artifact("S", nodeId, attemptId));
}
function sha256File(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function artifactFor(node, phase, attemptId, { status = "passed", flow = "C-R-A-F-T-S" } = {}) {
  const base = artifact(phase, node.id, attemptId, { status, flow, criterion: node.acceptance_criteria[0] || "criterion" });
  base.acceptance_criteria_status = node.acceptance_criteria.map((criterion) => ({ criterion, status: status === "passed" ? "met" : "unmet", evidence: [] }));
  return base;
}
function recordFullForNode(dispatcher, node, attemptId) {
  dispatcher.recordPhase(node.id, attemptId, "C", artifactFor(node, "C", attemptId));
  dispatcher.recordPhase(node.id, attemptId, "R", artifactFor(node, "R", attemptId));
  dispatcher.recordPhase(node.id, attemptId, "A", artifactFor(node, "A", attemptId));
  dispatcher.recordPhase(node.id, attemptId, "T", artifactFor(node, "T", attemptId));
  dispatcher.recordPhase(node.id, attemptId, "S", artifactFor(node, "S", attemptId));
}
function makeApproval(root, { run_id = "default", old_sha, new_sha, approver = "test", approved_at, approval_context = "approved", fileMode = 0o600 } = {}) {
  const approvalPath = path.join(root, "approval.json");
  const envelope = { schema_version: 1, run_id, expected_old_plan_sha256: old_sha, approved_new_plan_sha256: new_sha, approver, approved_at: approved_at || new Date().toISOString(), approval_context };
  fs.writeFileSync(approvalPath, JSON.stringify(envelope, null, 2));
  fs.chmodSync(approvalPath, fileMode);
  return approvalPath;
}
function copyPlan(root, sourcePath, name) {
  const dest = path.join(root, name);
  fs.copyFileSync(sourcePath, dest);
  return dest;
}
function makeMutatedPlan(root, basePath, mutator) {
  const plan = JSON.parse(fs.readFileSync(basePath, "utf8"));
  mutator(plan);
  const newPath = path.join(root, "plan-new.json");
  fs.writeFileSync(newPath, JSON.stringify(plan, null, 2));
  return newPath;
}

function writeLegacyLedger(dispatcher, plan, { nodeId = "a", attemptId = "a-attempt-1" } = {}) {
  const now = new Date().toISOString();
  const ledger = {
    schema_version: 1,
    run_id: dispatcher.runId,
    created_at: now,
    updated_at: now,
    frozen_plan_sha: sha256File(dispatcher.planPath),
    plan_path: path.relative(dispatcher.rootDir, dispatcher.planPath),
    nodes: {},
    amendments: [],
  };
  const node = plan.nodes.find((n) => n.id === nodeId);
  const phases = {};
  for (const phase of ["C", "R", "A", "T", "S"]) {
    const art = artifactFor(node, phase, attemptId);
    const rel = path.join("phases", nodeId, attemptId, `${phase}.json`);
    const full = path.join(dispatcher.ledgerDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const bytes = Buffer.from(`${JSON.stringify(art, null, 2)}\n`);
    fs.writeFileSync(full, bytes);
    phases[phase] = { path: rel, sha256: sha256(canonical(art)), status: "passed" };
  }
  const summary = { schema_version: 1, node_id: nodeId, attempt_id: attemptId, status: "passed", flow: "C-R-A-F-T-S", completed_at: now, phases };
  const compRel = path.join("nodes", nodeId, attemptId, "completion.json");
  const compFull = path.join(dispatcher.ledgerDir, compRel);
  fs.mkdirSync(path.dirname(compFull), { recursive: true });
  fs.writeFileSync(compFull, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`));
  ledger.nodes[nodeId] = {
    status: "passed",
    depends_on: [...node.depends_on],
    attempts: [{
      attempt_id: attemptId,
      sequence: 1,
      flow: "C-R-A-F-T-S",
      started_at: now,
      base_git: { available: false },
      phases,
      final_status: "passed",
      completed_at: now,
      completion_path: compRel,
    }],
  };
  for (const n of plan.nodes) {
    if (n.id !== nodeId) ledger.nodes[n.id] = { status: "pending", depends_on: [...n.depends_on], attempts: [] };
  }
  fs.mkdirSync(dispatcher.ledgerDir, { recursive: true });
  fs.writeFileSync(dispatcher.ledgerPath, JSON.stringify(ledger, null, 2));
}

const CANONICAL_PLAN_PATH = fileURLToPath(new URL("../../docs/raw/plans/proposed-build-dag.json", import.meta.url));

// The seven Decision-1 target pending nodes: all nodes within distance 2 of the root
// (domain-scaffolding) in the canonical 16-node plan. Their final acceptance criterion
// is treated as the appended amendment target for this end-to-end migration fixture.
const DECISION1_TARGET_NODE_IDS = new Set([
  "work-contracts-direct-intake",
  "model-routing-foundation",
  "codebase-knowledge-foundation",
  "orchestrator-decomposition-harness",
  "async-spec-intake-gate-one",
  "controller-ready-frontier",
  "isolated-pool-worker-execution",
]);

function readCanonicalPlanBytes() {
  return fs.readFileSync(CANONICAL_PLAN_PATH);
}

function deriveOldFixtureFromCanonical(canonicalBytes) {
  const plan = JSON.parse(canonicalBytes);
  for (const nodeId of DECISION1_TARGET_NODE_IDS) {
    const node = plan.nodes.find((n) => n.id === nodeId);
    assert.ok(node, `Decision-1 target node ${nodeId} must exist in canonical plan`);
    const finalCriterion = node.acceptance_criteria.at(-1);
    assert.ok(typeof finalCriterion === "string" && finalCriterion.length > 0, `Decision-1 target node ${nodeId} must have a non-empty final criterion`);
    node.acceptance_criteria.pop();
  }
  return Buffer.from(JSON.stringify(plan, null, 2));
}

function rel(root, p) { return path.relative(root, p); }
function migrateWithNewAtPlanPath(dispatcher, oldPlanPath, newPlanPath, approvalPath) {
  fs.copyFileSync(newPlanPath, dispatcher.planPath);
  const rootDir = dispatcher.rootDir;
  return dispatcher.migratePlan({
    oldPlanPath: rel(rootDir, fs.realpathSync(oldPlanPath)),
    newPlanPath: rel(rootDir, dispatcher.planPath),
    approvalPath: rel(rootDir, fs.realpathSync(approvalPath)),
  });
}

describe("GoalDispatcher", () => {
  let root, planPath, dispatcher;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-dispatcher-")); planPath = makePlan(root); dispatcher = new GoalDispatcher({ rootDir: root, planPath }); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("init freezes the plan and is idempotent", () => {
    assert.equal(dispatcher.init().created, true); assert.equal(dispatcher.init().created, false);
    const status = dispatcher.status(); assert.deepEqual(status.ready, ["a"]); assert.equal(status.planDrift, false);
    assert.equal(status.frozen_plan_sha, crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex"));
  });
  test("validatePlan accepts the canonical approved plan with kind/source/approval notes", () => {
    const canonicalPlanPath = fileURLToPath(new URL("../../docs/raw/plans/proposed-build-dag.json", import.meta.url));
    const result = GoalDispatcher.validatePlan(canonicalPlanPath);
    assert.equal(result.plan.schema_version, 1);
    assert.equal(result.plan.kind, "repository-builder-v1-build-dag");
    assert.equal(result.plan.approval.approved_by, "Kyler Berry");
    assert.ok(result.plan.approval.notes);
    assert.match(result.sha, /^[0-9a-f]{64}$/);
  });
  test("exclusive lock blocks another initializer", () => {
    fs.mkdirSync(dispatcher.ledgerDir, { recursive: true }); fs.writeFileSync(dispatcher.lockPath, `${process.pid}:held\n`);
    assert.throws(() => dispatcher.init(), /lock is held/);
  });
  test("concurrent CLI initialization never corrupts the ledger", async () => {
    const defaultPlan = path.join(root, "docs/raw/plans/proposed-build-dag.json");
    fs.mkdirSync(path.dirname(defaultPlan), { recursive: true }); fs.copyFileSync(planPath, defaultPlan);
    const script = fileURLToPath(new URL("./goal-dispatcher.mjs", import.meta.url));
    const launch = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [script, "init"], { cwd: root });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const results = await Promise.all([launch(), launch()]);
    assert.ok(results.some((result) => result.code === 0));
    assert.ok(results.every((result) => result.code === 0 || /lock is held/.test(result.stderr)));
    const successful = results.filter((result) => result.code === 0).map((result) => JSON.parse(result.stdout));
    assert.equal(successful.filter((result) => result.created === true).length, 1, "exactly one initializer creates the ledger");
    assert.ok(successful.filter((result) => result.created === false).length <= 1, "a sequential follower may observe the existing ledger");
    const ledger = JSON.parse(fs.readFileSync(path.join(root, ".pi/goal-runs/default/ledger.json"), "utf8"));
    assert.deepEqual(Object.keys(ledger.nodes).sort(), ["a", "b", "c"]);
  });
  test("start reserves one stable attempt and duplicate start resumes it", () => {
    dispatcher.init(); const first = dispatcher.start(); const replay = dispatcher.start();
    assert.equal(first.attempt_id, "a-attempt-1"); assert.deepEqual(replay, { ...first, resumed: true }); assert.deepEqual(dispatcher.status().inProgress, ["a"]);
  });
  test("start rejects a different node while one is active", () => {
    dispatcher.init(); dispatcher.start(); assert.throws(() => dispatcher.start({ nodeId: "b" }), /distinct git worktree/);
  });
  test("workspace guard blocks a distinct run ID in the same worktree", () => {
    dispatcher.init(); const first = dispatcher.start();
    const other = new GoalDispatcher({ rootDir: root, planPath, runId: "other" }); other.init();
    assert.throws(() => other.start(), /workspace already has active writer/);
    dispatcher.complete(first.node_id, first.attempt_id, "failed");
    assert.equal(other.start().node_id, "a");
  });
  test("unsafe run and node path segments are rejected", () => {
    assert.throws(() => new GoalDispatcher({ rootDir: root, planPath, runId: "../escape" }), /safe path segment/);
    const plan = JSON.parse(fs.readFileSync(planPath)); plan.nodes[0].id = "../escape"; fs.writeFileSync(planPath, JSON.stringify(plan));
    assert.throws(() => dispatcher.init(), /safe path segment/);
  });
  test("symlinked ledger ancestors are rejected", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goal-ledger-outside-"));
    fs.mkdirSync(path.join(root, ".pi"), { recursive: true }); fs.symlinkSync(outside, path.join(root, ".pi", "goal-runs"));
    try { assert.throws(() => dispatcher.init(), /symlinked dispatcher path/); } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test("artifact identity mismatch and invalid canonical payload reject", () => {
    dispatcher.init(); const active = dispatcher.start();
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "C", artifact("C", "wrong", active.attempt_id)), /identity/);
    const invalid = artifact("C", active.node_id, active.attempt_id); invalid.extra = true;
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "C", invalid), /unknown fields/);
  });
  test("canonical validation rejects duplicate changed files and malformed failure context", () => {
    dispatcher.init(); const active = dispatcher.start();
    const duplicate = artifact("C", active.node_id, active.attempt_id); duplicate.changed_files = ["x", "x"];
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "C", duplicate), /read-only|unique/);
    const malformed = artifact("C", active.node_id, active.attempt_id, { status: "needs_fix" }); malformed.failure_context = { failure_reason: 3 };
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "C", malformed), /failure_context/);
    const unknownTrigger = artifact("C", active.node_id, active.attempt_id); unknownTrigger.phase_data.security_triggers = ["subjective-risk-score"];
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "C", unknownTrigger), /security_triggers/);
  });
  test("criteria mapping must exactly match the approved node criteria", () => {
    dispatcher.init(); const active = dispatcher.start(); const wrong = artifact("C", active.node_id, active.attempt_id, { criterion: "invented" });
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "C", wrong), /original criterion/);
  });
  test("CLI rejects artifact reads outside the run incoming directory", () => {
    const defaultPlan = path.join(root, "docs/raw/plans/proposed-build-dag.json"); fs.mkdirSync(path.dirname(defaultPlan), { recursive: true }); fs.copyFileSync(planPath, defaultPlan);
    const script = fileURLToPath(new URL("./goal-dispatcher.mjs", import.meta.url));
    assert.equal(spawnSync(process.execPath, [script, "init"], { cwd: root }).status, 0);
    const started = JSON.parse(spawnSync(process.execPath, [script, "start"], { cwd: root, encoding: "utf8" }).stdout);
    const outside = path.join(root, "outside.json"); fs.writeFileSync(outside, JSON.stringify(artifact("C", started.node_id, started.attempt_id)));
    const result = spawnSync(process.execPath, [script, "record-phase", started.node_id, started.attempt_id, "C", outside], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /under .*incoming/);
  });
  test("phase order is enforced", () => {
    dispatcher.init(); const active = dispatcher.start();
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id)), /expected C/);
  });
  test("identical phase replay is idempotent and conflicting replay rejects", () => {
    dispatcher.init(); const active = dispatcher.start(); const value = artifact("C", active.node_id, active.attempt_id);
    assert.equal(dispatcher.recordPhase(active.node_id, active.attempt_id, "C", value).replayed, false);
    assert.equal(dispatcher.recordPhase(active.node_id, active.attempt_id, "C", value).replayed, true);
    const conflict = structuredClone(value); conflict.summary = "different";
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "C", conflict), /conflicting replay/);
  });
  test("passed completion requires all full-flow phases", () => {
    dispatcher.init(); const active = dispatcher.start();
    assert.throws(() => dispatcher.complete(active.node_id, active.attempt_id, "passed"), /incomplete/);
    recordFull(dispatcher, active.node_id, active.attempt_id); dispatcher.complete(active.node_id, active.attempt_id, "passed");
    assert.deepEqual(dispatcher.status().ready, ["b", "c"]);
  });
  test("needs-fix assessment requires a passing F artifact", () => {
    dispatcher.init(); const active = dispatcher.start(); recordFull(dispatcher, active.node_id, active.attempt_id, { assessmentStatus: "needs_fix" });
    dispatcher.complete(active.node_id, active.attempt_id, "passed"); assert.deepEqual(dispatcher.status().completed, ["a"]);
  });
  test("needs-fix Tighten routes through Fix and an immutable Tighten recheck", () => {
    dispatcher.init(); const active = dispatcher.start();
    dispatcher.recordPhase(active.node_id, active.attempt_id, "C", artifact("C", active.node_id, active.attempt_id));
    dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id));
    dispatcher.recordPhase(active.node_id, active.attempt_id, "A", artifact("A", active.node_id, active.attempt_id, { status: "needs_fix" }));
    dispatcher.recordPhase(active.node_id, active.attempt_id, "F", artifact("F", active.node_id, active.attempt_id));
    const firstT = artifact("T", active.node_id, active.attempt_id, { status: "needs_fix" });
    firstT.summary = "first Tighten finding";
    const firstTRecord = dispatcher.recordPhase(active.node_id, active.attempt_id, "T", firstT);
    assert.equal(firstTRecord.path.endsWith("T.json"), true);

    // Simulate an active ledger written before phase_history existed.
    const legacyLedger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    delete legacyLedger.nodes.a.attempts[0].phase_history;
    fs.writeFileSync(dispatcher.ledgerPath, JSON.stringify(legacyLedger, null, 2));
    dispatcher = new GoalDispatcher({ rootDir: root, planPath });
    assert.equal(dispatcher.resume().active_attempt.next_phase, "F");

    const secondF = artifact("F", active.node_id, active.attempt_id); secondF.summary = "Tighten fix";
    const secondFRecord = dispatcher.recordPhase(active.node_id, active.attempt_id, "F", secondF);
    assert.equal(secondFRecord.path.endsWith("F-2.json"), true);
    assert.equal(dispatcher.resume().active_attempt.next_phase, "T");

    const secondT = artifact("T", active.node_id, active.attempt_id); secondT.summary = "Tighten passed";
    const secondTRecord = dispatcher.recordPhase(active.node_id, active.attempt_id, "T", secondT);
    assert.equal(secondTRecord.path.endsWith("T-2.json"), true);

    // Simulate a partially migrated per-phase history missing the current T pointer.
    const partialLedger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    partialLedger.nodes.a.attempts[0].phase_history.T = [partialLedger.nodes.a.attempts[0].phase_history.T[0]];
    fs.writeFileSync(dispatcher.ledgerPath, JSON.stringify(partialLedger, null, 2));
    dispatcher = new GoalDispatcher({ rootDir: root, planPath });
    assert.equal(dispatcher.resume().active_attempt.next_phase, "S");
    dispatcher.recordPhase(active.node_id, active.attempt_id, "S", artifact("S", active.node_id, active.attempt_id));
    dispatcher.complete(active.node_id, active.attempt_id, "passed");

    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    const attempt = ledger.nodes.a.attempts[0];
    assert.deepEqual(Object.keys(attempt.phase_history).sort(), ["A", "C", "F", "R", "S", "T"]);
    assert.equal(attempt.phase_history.F.length, 2);
    assert.equal(attempt.phase_history.T.length, 2);
    assert.equal(attempt.phases.T.status, "passed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dispatcher.ledgerDir, firstTRecord.path))).status, "needs_fix");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dispatcher.ledgerDir, secondTRecord.path))).status, "passed");

    const oldSnapshot = copyPlan(root, planPath, "plan-before-history-migration.json");
    const newPath = makeMutatedPlan(root, planPath, (plan) => plan.nodes.find((node) => node.id === "b").acceptance_criteria.push("extra B"));
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    const migration = migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath);
    assert.equal(migration.replayed, false);
    const manifest = JSON.parse(fs.readFileSync(path.join(dispatcher.ledgerDir, "migrations", "objects", migration.manifest_sha), "utf8"));
    assert.equal(manifest.completed_evidence[0].phase_digests.length, 8);
  });
  test("explicit retry preserves a failed attempt and creates a new audited attempt", () => {
    dispatcher.init(); const first = dispatcher.start(); dispatcher.complete(first.node_id, first.attempt_id, "failed");
    const retried = dispatcher.retry({ nodeId: "a", approvedBy: "kyler", reason: "repair failed Tighten findings" });
    assert.equal(retried.attempt_id, "a-attempt-2");
    assert.equal(retried.retry_of, "a-attempt-1");
    assert.deepEqual(dispatcher.status().inProgress, ["a"]);
    assert.deepEqual(dispatcher.status().blocked, []);
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.equal(ledger.nodes.a.attempts[0].final_status, "failed");
    assert.deepEqual({ ...ledger.nodes.a.attempts[1].retry, authorized_at: undefined }, { retry_of: "a-attempt-1", approved_by: "kyler", reason: "repair failed Tighten findings", authorized_at: undefined });
    assert.ok(!Number.isNaN(Date.parse(ledger.nodes.a.attempts[1].retry.authorized_at)));
    assert.throws(() => dispatcher.retry({ nodeId: "a", approvedBy: "kyler", reason: "duplicate" }), /failed or escalated/);
  });
  test("lite flow requires only R and S", () => {
    dispatcher.init(); const active = dispatcher.start({ flow: "R-S" });
    dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id, { flow: "R-S" }));
    dispatcher.recordPhase(active.node_id, active.attempt_id, "S", artifact("S", active.node_id, active.attempt_id, { flow: "R-S" }));
    const completed = dispatcher.complete(active.node_id, active.attempt_id, "passed");
    assert.deepEqual(dispatcher.status().completed, ["a"]);
    assert.equal(completed.telemetry_candidate.status, "written");
    const candidate = JSON.parse(fs.readFileSync(path.join(root, completed.telemetry_candidate.path), "utf8"));
    assert.equal(candidate.eligibility, "telemetry-only");
    assert.ok(candidate.eligibility_reasons.includes("missing_actual_usage"));
  });
  test("completed attempts reject additional phase writes", () => {
    dispatcher.init(); const active = dispatcher.start({ flow: "R-S" });
    dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id, { flow: "R-S" }));
    dispatcher.recordPhase(active.node_id, active.attempt_id, "S", artifact("S", active.node_id, active.attempt_id, { flow: "R-S" })); dispatcher.complete(active.node_id, active.attempt_id, "passed");
    assert.throws(() => dispatcher.recordPhase(active.node_id, active.attempt_id, "F", artifact("F", active.node_id, active.attempt_id)), /active attempt|order/);
  });
  test("resume returns the active attempt and next phase", () => {
    dispatcher.init(); const active = dispatcher.start(); dispatcher.recordPhase(active.node_id, active.attempt_id, "C", artifact("C", active.node_id, active.attempt_id));
    const reopened = new GoalDispatcher({ rootDir: root, planPath });
    assert.deepEqual(reopened.resume().active_attempt, { node_id: "a", attempt_id: active.attempt_id, flow: "C-R-A-F-T-S", next_phase: "R" });
  });
  test("plan drift is reported and blocks mutation and resume", () => {
    dispatcher.init(); const plan = JSON.parse(fs.readFileSync(planPath)); plan.nodes[0].intent = "changed"; fs.writeFileSync(planPath, JSON.stringify(plan));
    assert.equal(dispatcher.status().planDrift, true); assert.throws(() => dispatcher.start(), /drift/); assert.throws(() => dispatcher.resume(), /drift/);
  });
  test("candidate write failure degrades telemetry without rolling back completion", () => {
    dispatcher.init(); const active = dispatcher.start({ flow: "R-S" });
    dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id, { flow: "R-S" }));
    dispatcher.recordPhase(active.node_id, active.attempt_id, "S", artifact("S", active.node_id, active.attempt_id, { flow: "R-S" }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-outside-"));
    const evalPath = path.join(dispatcher.ledgerDir, "eval-candidates"); fs.symlinkSync(outside, evalPath);
    try {
      const completed = dispatcher.complete(active.node_id, active.attempt_id, "passed");
      assert.equal(completed.status, "passed"); assert.equal(completed.telemetry_candidate.status, "degraded");
      assert.deepEqual(dispatcher.status().completed, ["a"]);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test("failure blocks dependent branches", () => {
    dispatcher.init(); const active = dispatcher.start(); dispatcher.complete(active.node_id, active.attempt_id, "failed");
    const status = dispatcher.status(); assert.deepEqual(status.failed, ["a"]); assert.deepEqual(status.blocked, ["b", "c"]);
  });
});

describe("migrate-plan", () => {
  let root, planPath, dispatcher;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-migrate-")); planPath = makePlan(root); dispatcher = new GoalDispatcher({ rootDir: root, planPath }); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function setupCompletedRoot() {
    dispatcher.init();
    const active = dispatcher.start();
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const nodeA = plan.nodes.find((node) => node.id === "a");
    recordFullForNode(dispatcher, nodeA, active.attempt_id);
    dispatcher.complete(active.node_id, active.attempt_id, "passed");
    const oldSnapshot = copyPlan(root, planPath, "plan-old.json");
    return { plan, active, oldSnapshot };
  }

  test("happy path migrates pending nodes with appended criteria", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra B"); p.nodes.find((n) => n.id === "c").acceptance_criteria.push("extra C"); });
    const oldSha = sha256File(oldSnapshot); const newSha = sha256File(newPath);
    const approvalPath = makeApproval(root, { old_sha: oldSha, new_sha: newSha });
    const result = migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath);
    assert.equal(result.replayed, false); assert.equal(result.old_plan_sha, oldSha); assert.equal(result.new_plan_sha, newSha);
    const status = dispatcher.status();
    assert.equal(status.planDrift, false); assert.deepEqual(status.completed, ["a"]); assert.deepEqual(status.ready, ["b", "c"]);
    assert.deepEqual(status.inProgress, []);
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.equal(ledger.amendments.length, 1);
    assert.equal(ledger.amendments[0].old_plan_sha, oldSha);
    assert.equal(ledger.amendments[0].new_plan_sha, newSha);
    assert.ok(ledger.amendments[0].trust_basis.path);
    assert.equal(typeof ledger.amendments[0].approval_envelope_sha, "string");
    assert.equal(ledger.amendments[0].evidence_manifest_sha, result.manifest_sha);
    assert.match(ledger.amendments[0].amendment_object_sha, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(dispatcher.ledgerDir, "migrations", "objects", ledger.amendments[0].amendment_object_sha)));
    const manifest = JSON.parse(fs.readFileSync(path.join(dispatcher.ledgerDir, "migrations", "objects", ledger.amendments[0].evidence_manifest_sha), "utf8"));
    assert.equal(manifest.old_plan_sha, oldSha);
    assert.equal(manifest.new_plan_sha, newSha);
    assert.equal(manifest.completed_evidence.length, 1);
    assert.equal(manifest.completed_evidence[0].phase_digests.length, 5);
    assert.ok(manifest.completed_evidence[0].completion_sha256);
  });

  test("rejects wrong old and new hashes", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const wrongOld = makeApproval(root, { old_sha: "0".repeat(64), new_sha: sha256File(newPath) });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, wrongOld), /old plan hash/);
    const wrongNew = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: "1".repeat(64) });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, wrongNew), /new plan hash/);
  });

  test("rejects active attempt and workspace writer", () => {
    dispatcher.init(); dispatcher.start();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const oldSnapshot = copyPlan(root, planPath, "plan-old.json");
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    fs.copyFileSync(newPath, planPath);
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /active attempt/);
    fs.copyFileSync(oldSnapshot, planPath);
    dispatcher.complete("a", "a-attempt-1", "failed");
    fs.copyFileSync(newPath, planPath);
    const otherGuard = { run_id: "other", node_id: "x", attempt_id: "x-1", workspace: root };
    fs.mkdirSync(dispatcher.ledgerBase, { recursive: true });
    fs.writeFileSync(dispatcher.workspaceGuardPath, JSON.stringify(otherGuard));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /workspace already has active writer|migration guard/);
  });

  test("rejects changed completed definition or evidence", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const changedCompleted = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "a").acceptance_criteria.push("changed"); });
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(changedCompleted) });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, changedCompleted, approvalPath), /completed node.*acceptance_criteria changed/);
  });

  test("rejects evidence tampering", () => {
    const { active, oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const phasePath = path.join(dispatcher.ledgerDir, "phases", "a", active.attempt_id, "C.json");
    const tampered = JSON.parse(fs.readFileSync(phasePath, "utf8"));
    tampered.summary = "tampered";
    fs.writeFileSync(phasePath, JSON.stringify(tampered, null, 2));
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /digest mismatch|canonical digest mismatch/);
  });

  test("rejects invalid topology and node ID changes", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const changedDep = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").depends_on = ["c"]; });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, changedDep, makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(changedDep) })), /depends_on changed/);
    const addedNode = makeMutatedPlan(root, planPath, (p) => { p.nodes.push({ id: "d", intent: "D", change_spec: "D", acceptance_criteria: ["D"], depends_on: ["a"] }); });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, addedNode, makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(addedNode) })), /node count changed/);
    const cycled = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "a").depends_on = ["b"]; p.nodes.find((n) => n.id === "b").depends_on = ["a"]; });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, cycled, makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(cycled) })), /cycle/);
  });

  test("rejects stale or mismatched approval envelope", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const stale = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath), run_id: "other" });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, stale), /run_id/);
    const foreign = path.join(root, "foreign.json");
    fs.writeFileSync(foreign, JSON.stringify({ schema_version: 1, run_id: "default", expected_old_plan_sha256: sha256File(oldSnapshot), approved_new_plan_sha256: sha256File(newPath), approver: "test", approved_at: new Date().toISOString(), approval_context: "approved", extra: true }));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, foreign), /unknown fields/);
  });

  test("rejects writable or symlinked approval files", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const writable = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath), fileMode: 0o666 });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, writable), /group or world writable/);
    const real = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    const link = path.join(root, "approval-link.json"); fs.symlinkSync(real, link);
    fs.copyFileSync(newPath, planPath);
    assert.throws(() => dispatcher.migratePlan({ oldPlanPath: "plan-old.json", newPlanPath: "plan.json", approvalPath: "approval-link.json" }), /symlink/);
  });

  test("rejects bounded malformed input", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const badPlan = path.join(root, "bad.json"); fs.writeFileSync(badPlan, JSON.stringify({ schema_version: 1, nodes: [{ id: "a".repeat(200), intent: "A", change_spec: "X", acceptance_criteria: ["c"], depends_on: [] }], approval: { approved_by: "test", approved_at: new Date().toISOString() } }));
    const good = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, badPlan, good, makeApproval(root, { old_sha: sha256File(badPlan), new_sha: sha256File(good) })), /out of bounds|safe path segment/);
    const badEnvelope = path.join(root, "bad-approval.json"); fs.writeFileSync(badEnvelope, JSON.stringify({ schema_version: 1, run_id: "default", expected_old_plan_sha256: sha256File(oldSnapshot), approved_new_plan_sha256: sha256File(good), approver: "test", approved_at: "not-a-date", approval_context: "x" }));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, good, badEnvelope), /date-time/);
  });

  test("rejects unsafe content-addressed object collision", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const oldSha = sha256File(oldSnapshot);
    const collisionDir = path.join(dispatcher.ledgerDir, "migrations", "objects");
    fs.mkdirSync(collisionDir, { recursive: true });
    const collisionPath = path.join(collisionDir, oldSha);
    fs.writeFileSync(collisionPath, "wrong bytes");
    fs.chmodSync(collisionPath, 0o600);
    const approvalPath = makeApproval(root, { old_sha: oldSha, new_sha: sha256File(newPath) });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /collision/);
  });

  test("replay is idempotent and conflicting replay rejects", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    const first = migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath);
    assert.equal(first.replayed, false);
    const second = migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath);
    assert.equal(second.replayed, true); assert.equal(second.amendment_index, first.amendment_index);
    const otherPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "c").acceptance_criteria.push("other"); });
    const otherApproval = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(otherPath) });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, otherPath, otherApproval), /conflicting migration replay/);
  });

  test("verifies historical ledger without bytes_sha256 or completion_sha256", () => {
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    writeLegacyLedger(dispatcher, plan);
    const oldSnapshot = copyPlan(root, planPath, "plan-old.json");
    const oldSha = sha256File(oldSnapshot);
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra B"); });
    const newSha = sha256File(newPath);
    fs.copyFileSync(newPath, planPath);
    const approvalPath = makeApproval(root, { old_sha: oldSha, new_sha: newSha });
    const result = dispatcher.migratePlan({ oldPlanPath: rel(root, oldSnapshot), newPlanPath: rel(root, planPath), approvalPath: rel(root, approvalPath) });
    assert.equal(result.replayed, false);
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.equal(ledger.amendments.length, 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(dispatcher.ledgerDir, "migrations", "objects", ledger.amendments[0].evidence_manifest_sha), "utf8"));
    assert.equal(manifest.completed_evidence[0].phase_digests.length, 5);
    assert.ok(manifest.completed_evidence[0].completion_sha256);
  });

  test("rejects symlink ancestors and final symlinks for inputs", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const realDir = path.join(root, "real"); fs.mkdirSync(realDir);
    fs.copyFileSync(oldSnapshot, path.join(realDir, "plan.json"));
    const linkDir = path.join(root, "link"); fs.symlinkSync(realDir, linkDir);
    const approvalPath1 = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    fs.copyFileSync(newPath, planPath);
    assert.throws(() => dispatcher.migratePlan({ oldPlanPath: path.join("link", "plan.json"), newPlanPath: "plan.json", approvalPath: "approval.json" }), /symlinked dispatcher path/);
    const realApproval = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    const linkApproval = path.join(root, "approval-link.json"); fs.symlinkSync(realApproval, linkApproval);
    assert.throws(() => dispatcher.migratePlan({ oldPlanPath: "plan-old.json", newPlanPath: "plan.json", approvalPath: "approval-link.json" }), /symlink/);
  });

  test("rejects ledger evidence traversal and symlinks", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    ledger.nodes.a.attempts[0].completion_path = path.join("..", "..", "outside-completion.json");
    fs.writeFileSync(dispatcher.ledgerPath, JSON.stringify(ledger, null, 2));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) })), /path is unsafe/);
    const outside = path.join(root, "outside-completion.json");
    fs.writeFileSync(outside, "{}");
    const linkPath = path.join(dispatcher.ledgerDir, "symlink-completion.json");
    fs.symlinkSync(outside, linkPath);
    ledger.nodes.a.attempts[0].completion_path = "symlink-completion.json";
    fs.writeFileSync(dispatcher.ledgerPath, JSON.stringify(ledger, null, 2));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) })), /symlink/);
  });

  test("rejects stale or future approval", () => {
    const oldApprovedAt = new Date("2020-01-01T00:00:00Z").toISOString();
    const currentPlanPath = path.join(root, "current-plan.json");
    fs.writeFileSync(currentPlanPath, JSON.stringify({
      schema_version: 1,
      nodes: [{ id: "a", intent: "A", change_spec: "Do A", acceptance_criteria: ["A works"], depends_on: [] }],
      approval: { approved_by: "test", approved_at: oldApprovedAt },
    }, null, 2));
    dispatcher = new GoalDispatcher({ rootDir: root, planPath: currentPlanPath });
    const oldSnapshot = copyPlan(root, currentPlanPath, "plan-old.json");
    const newPath = path.join(root, "plan-new.json");
    fs.writeFileSync(newPath, JSON.stringify({
      schema_version: 1,
      nodes: [{ id: "a", intent: "A", change_spec: "Do A changed", acceptance_criteria: ["A works"], depends_on: [] }],
      approval: { approved_by: "test", approved_at: new Date().toISOString() },
    }, null, 2));
    fs.copyFileSync(newPath, currentPlanPath);
    const staleApproval = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath), approved_at: oldApprovedAt });
    assert.throws(() => dispatcher.migratePlan({ oldPlanPath: rel(root, oldSnapshot), newPlanPath: rel(root, currentPlanPath), approvalPath: rel(root, staleApproval) }), /later than the old plan approval/);
    const futureApproval = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath), approved_at: new Date(Date.now() + CLOCK_SKEW_MS + 60_000).toISOString() });
    assert.throws(() => dispatcher.migratePlan({ oldPlanPath: rel(root, oldSnapshot), newPlanPath: rel(root, currentPlanPath), approvalPath: rel(root, futureApproval) }), /too far in the future/);
  });

  test("rejects deeply nested or oversized plan/envelope", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const deepPlan = path.join(root, "deep.json");
    let deep = { schema_version: 1, nodes: [], approval: { approved_by: "test", approved_at: new Date().toISOString() } };
    let current = deep;
    for (let i = 0; i < 40; i += 1) { current.nested = {}; current = current.nested; }
    fs.writeFileSync(deepPlan, JSON.stringify(deep));
    const good = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, deepPlan, good, makeApproval(root, { old_sha: sha256File(deepPlan), new_sha: sha256File(good) })), /exceeds maximum nesting depth/);
    const bigArrayPlan = path.join(root, "bigarray.json");
    fs.writeFileSync(bigArrayPlan, JSON.stringify({ schema_version: 1, nodes: [{ id: "a", intent: "A", change_spec: "X", acceptance_criteria: Array(5000).fill("c"), depends_on: [] }], approval: { approved_by: "test", approved_at: new Date().toISOString() } }));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, bigArrayPlan, good, makeApproval(root, { old_sha: sha256File(bigArrayPlan), new_sha: sha256File(good) })), /array exceeds maximum length|value count/);
    const bigStringPlan = path.join(root, "bigstring.json");
    fs.writeFileSync(bigStringPlan, JSON.stringify({ schema_version: 1, nodes: [{ id: "a", intent: "A".repeat(200_000), change_spec: "X", acceptance_criteria: ["c"], depends_on: [] }], approval: { approved_by: "test", approved_at: new Date().toISOString() } }));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, bigStringPlan, good, makeApproval(root, { old_sha: sha256File(bigStringPlan), new_sha: sha256File(good) })), /string exceeds maximum length|out of bounds/);
    const deepApproval = path.join(root, "deep-approval.json");
    let deepEnv = { schema_version: 1, run_id: "default", expected_old_plan_sha256: sha256File(oldSnapshot), approved_new_plan_sha256: sha256File(good), approver: "test", approved_at: new Date().toISOString(), approval_context: "x" };
    current = deepEnv;
    for (let i = 0; i < 20; i += 1) { current.nested = {}; current = current.nested; }
    fs.writeFileSync(deepApproval, JSON.stringify(deepEnv));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, good, deepApproval), /exceeds maximum nesting depth/);
  });

  test("retry succeeds after pre-activation failure", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    let calls = 0;
    const original = dispatcher._writeLedger.bind(dispatcher);
    dispatcher._writeLedger = (ledger) => { if (calls++ === 0) throw new Error("simulated activation failure"); original(ledger); };
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /simulated activation failure/);
    assert.equal(fs.existsSync(dispatcher.workspaceGuardPath), false);
    dispatcher._writeLedger = original;
    const result = migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath);
    assert.equal(result.replayed, false);
    assert.equal(dispatcher.status().planDrift, false);
  });

  test("replay rejects tampered immutable object", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath);
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    const oldObjectPath = path.join(dispatcher.ledgerDir, "migrations", "objects", ledger.amendments[0].old_plan_sha);
    fs.writeFileSync(oldObjectPath, "tampered");
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /digest mismatch/);
  });

  test("preserves canonical plan file mode", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    fs.chmodSync(planPath, 0o644);
    const modeBefore = fs.statSync(planPath).mode;
    migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) }));
    const modeAfter = fs.statSync(planPath).mode;
    assert.equal(modeAfter, modeBefore);
  });

  test("durable end-to-end migration on canonical 16-node plan", () => {
    const canonicalBytes = readCanonicalPlanBytes();
    const oldBytes = deriveOldFixtureFromCanonical(canonicalBytes);

    const oldPlanPath = path.join(root, "plan-old.json");
    fs.writeFileSync(oldPlanPath, oldBytes);
    const newPlanPath = path.join(root, "plan.json");
    fs.writeFileSync(newPlanPath, oldBytes);

    const localDispatcher = new GoalDispatcher({ rootDir: root, planPath: newPlanPath });
    localDispatcher.init();

    const active = localDispatcher.start();
    assert.equal(active.node_id, "domain-scaffolding");

    const oldPlan = JSON.parse(oldBytes);
    const domainScaffoldingNode = oldPlan.nodes.find((n) => n.id === "domain-scaffolding");
    recordFullForNode(localDispatcher, domainScaffoldingNode, active.attempt_id);
    localDispatcher.complete(active.node_id, active.attempt_id, "passed");

    fs.writeFileSync(newPlanPath, canonicalBytes);

    const oldSha = sha256(oldBytes);
    const newSha = sha256(canonicalBytes);
    const approvalPath = makeApproval(root, { old_sha: oldSha, new_sha: newSha });

    const result = localDispatcher.migratePlan({
      oldPlanPath: rel(root, oldPlanPath),
      newPlanPath: rel(root, newPlanPath),
      approvalPath: rel(root, approvalPath),
    });

    assert.equal(result.replayed, false);
    const status = localDispatcher.status();
    assert.equal(status.planDrift, false);
    assert.deepEqual(status.completed, ["domain-scaffolding"]);
    assert.deepEqual(status.ready, ["codebase-knowledge-foundation", "model-routing-foundation", "work-contracts-direct-intake"]);
    assert.deepEqual(status.inProgress, []);
    assert.equal(fs.existsSync(localDispatcher.workspaceGuardPath), false);

    const ledger = JSON.parse(fs.readFileSync(localDispatcher.ledgerPath, "utf8"));
    assert.equal(ledger.amendments.length, 1);
    assert.equal(ledger.amendments[0].old_plan_sha, oldSha);
    assert.equal(ledger.amendments[0].new_plan_sha, newSha);
    assert.equal(Object.hasOwn(result, "telemetry_candidate"), false);
  });

  test("does not emit dispatch evidence or eval candidates", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const result = migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) }));
    assert.equal(Object.hasOwn(result, "telemetry_candidate"), false);
  });

  function tamperHook(dispatcher, tamperFn) {
    const original = dispatcher._migrationHook.bind(dispatcher);
    dispatcher._migrationHook = (name) => {
      if (name === "before-activation-recheck") tamperFn();
      original(name);
    };
  }

  test("rejects reused content-addressed object not exactly mode 0600", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const oldSha = sha256File(oldSnapshot);
    const objectDir = path.join(dispatcher.ledgerDir, "migrations", "objects");
    fs.mkdirSync(objectDir, { recursive: true });
    fs.writeFileSync(path.join(objectDir, oldSha), fs.readFileSync(oldSnapshot));
    fs.chmodSync(path.join(objectDir, oldSha), 0o644);
    const approvalPath = makeApproval(root, { old_sha: oldSha, new_sha: sha256File(newPath) });
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /mode 0600/);
  });

  test("rejects TOCTOU symlink replacement of ledger chain before activation", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    let tampered = false;
    tamperHook(dispatcher, () => {
      if (tampered) return;
      tampered = true;
      const ledgerBase = dispatcher.ledgerBase;
      const moved = `${ledgerBase}.moved`;
      fs.renameSync(ledgerBase, moved);
      fs.symlinkSync(moved, ledgerBase);
    });
    const frozenBefore = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8")).frozen_plan_sha;
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /directory identity changed|is not a real directory/);
    const frozenAfter = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8")).frozen_plan_sha;
    assert.equal(frozenAfter, frozenBefore);
    assert.equal(fs.existsSync(dispatcher.workspaceGuardPath), false);
  });

  test("rejects TOCTOU inode replacement of ledger chain before activation", () => {
    const { oldSnapshot } = setupCompletedRoot();
    const newPath = makeMutatedPlan(root, planPath, (p) => { p.nodes.find((n) => n.id === "b").acceptance_criteria.push("extra"); });
    const approvalPath = makeApproval(root, { old_sha: sha256File(oldSnapshot), new_sha: sha256File(newPath) });
    let tampered = false;
    tamperHook(dispatcher, () => {
      if (tampered) return;
      tampered = true;
      const ledgerBase = dispatcher.ledgerBase;
      const moved = `${ledgerBase}.moved`;
      fs.renameSync(ledgerBase, moved);
      fs.mkdirSync(ledgerBase, 0o700);
    });
    const ledgerBefore = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.throws(() => migrateWithNewAtPlanPath(dispatcher, oldSnapshot, newPath, approvalPath), /directory identity changed/);
    const frozenAfter = JSON.parse(fs.readFileSync(path.join(`${dispatcher.ledgerBase}.moved`, dispatcher.runId, "ledger.json"), "utf8")).frozen_plan_sha;
    assert.equal(frozenAfter, ledgerBefore.frozen_plan_sha);
    assert.equal(fs.existsSync(dispatcher.workspaceGuardPath), false);
  });
});
