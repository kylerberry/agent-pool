import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GoalDispatcher } from "./goal-dispatcher.mjs";

function makePlan(root) {
  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify({
    schema_version: 1,
    nodes: [
      { id: "a", intent: "A", change_spec: "Do A", acceptance_criteria: ["A works"], depends_on: [] },
      { id: "b", intent: "B", change_spec: "Do B", acceptance_criteria: ["B works"], depends_on: ["a"] },
      { id: "c", intent: "C", change_spec: "Do C", acceptance_criteria: ["C works"], depends_on: ["a"] },
    ],
    approval: { approved_by: "test", approved_at: new Date().toISOString() },
  }, null, 2));
  return planPath;
}
const evidence = () => ({ commit_sha: "abc", suite_path: "test", suite_hash: "hash", command: "test", exit_code: 0, image_digest: "local", output_artifact: "output" });
const scores = () => Object.fromEntries(["correctness_risk", "locality_simplicity", "interface_clarity", "type_error_safety", "test_quality"].map((key) => [key, { score: 3, rationale: key }]));
function phaseData(phase, flow = "C-R-A-F-T-S") {
  if (phase === "C") return { complexity: "full", selected_flow: flow, scope: "scope", non_goals: [], test_strategy: ["test"], planned_files: ["file"], trust_boundaries: [], render_plan: ["render"] };
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

describe("GoalDispatcher", () => {
  let root, planPath, dispatcher;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-dispatcher-")); planPath = makePlan(root); dispatcher = new GoalDispatcher({ rootDir: root, planPath }); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("init freezes the plan and is idempotent", () => {
    assert.equal(dispatcher.init().created, true); assert.equal(dispatcher.init().created, false);
    const status = dispatcher.status(); assert.deepEqual(status.ready, ["a"]); assert.equal(status.planDrift, false);
    assert.equal(status.frozen_plan_sha, crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex"));
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
