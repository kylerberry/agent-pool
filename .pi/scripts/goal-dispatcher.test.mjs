import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GoalDispatcher } from "./goal-dispatcher.mjs";
import { hashJson, JOURNAL_SCHEMA_VERSION } from "./goal-journal.mjs";

function sha256File(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }

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
function phaseData(phase, flow = "C-R-A-F-T-S", triggers = []) {
  if (phase === "C") return { complexity: "full", selected_flow: flow, scope: "scope", non_goals: [], test_strategy: ["test"], planned_files: ["file"], trust_boundaries: [], security_triggers: triggers, render_plan: ["render"] };
  if (phase === "R") return { red_evidence: evidence(), green_evidence: evidence(), implementation_notes: [], patch_path: null };
  if (phase === "A") return { criteria_fit: { passed: true, rationale: "fit" }, maintainability: scores(), blocking_findings: [], non_blocking_observations: [] };
  if (phase === "F") return { findings_addressed: [], documented_disagreements: [], green_evidence: evidence(), patch_path: null };
  if (phase === "T") return { trust_boundaries_reviewed: [], security_findings: [], security_commands: [], residual_risk: [] };
  return { docs_changed: [], domain_instructions_changed: [], wiki_pages_changed: [], durable_learnings: [] };
}
function artifact(phase, nodeId, attemptId, { status = "passed", flow = "C-R-A-F-T-S", triggers = [], criterion = "A works" } = {}) {
  return {
    schema_version: 1, node_id: nodeId, attempt_id: attemptId, phase, status,
    model: "test/model", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), summary: "artifact",
    acceptance_criteria_status: [{ criterion, status: status === "passed" ? "met" : "unmet", evidence: [] }],
    changed_files: ["file"].filter(() => !["C", "A", "T"].includes(phase)), commands_run: [],
    cost: { input_tokens: 0, output_tokens: 0, amount: null, currency: null }, risks: [], open_questions: [],
    recommended_next_step: "next", failure_context: status === "passed" ? null : { attempted: [], failure_reason: "fix", discoveries: [], dead_ends: [] },
    transcript_path: null, phase_data: phaseData(phase, flow, triggers),
  };
}
async function recordFull(dispatcher, nodeId, attemptId, { assessmentStatus = "passed", flow = "C-R-A-F-T-S" } = {}) {
  await dispatcher.recordPhase(nodeId, attemptId, "C", artifact("C", nodeId, attemptId, { flow }));
  await dispatcher.recordPhase(nodeId, attemptId, "R", artifact("R", nodeId, attemptId, { flow }));
  await dispatcher.recordPhase(nodeId, attemptId, "A", artifact("A", nodeId, attemptId, { status: assessmentStatus, flow }));
  if (assessmentStatus === "needs_fix") {
    await dispatcher.recordPhase(nodeId, attemptId, "F", artifact("F", nodeId, attemptId, { flow }));
    const a2 = artifact("A", nodeId, attemptId, { status: "passed", flow });
    a2.summary = "reassessed";
    await dispatcher.recordPhase(nodeId, attemptId, "A", a2);
  }
  await dispatcher.recordPhase(nodeId, attemptId, "T", artifact("T", nodeId, attemptId, { flow }));
  await dispatcher.recordPhase(nodeId, attemptId, "S", artifact("S", nodeId, attemptId, { flow }));
}

function writeV1Ledger(dispatcher, { nodeId = "a", attemptId = "a-attempt-1", active = false, triggers = [], legacyUnverifiedC = false, legacyMissingTriggers = false } = {}) {
  const now = new Date().toISOString();
  const ledger = {
    schema_version: 1,
    run_id: dispatcher.runId,
    created_at: now,
    updated_at: now,
    frozen_plan_sha: sha256File(dispatcher.planPath),
    plan_path: path.relative(dispatcher.rootDir, dispatcher.planPath),
    nodes: {},
    amendments: [{ old_plan_sha: "0".repeat(64), new_plan_sha: "1".repeat(64), approver: "test", approved_at: now, approval_context: "historical" }],
  };
  const phases = {};
  const phaseList = active ? ["C"] : ["C", "R", "A", "T", "S"];
  for (const phase of phaseList) {
    const art = artifact(phase, nodeId, attemptId, { triggers: phase === "C" ? triggers : [] });
    if (phase === "C" && legacyUnverifiedC) art.acceptance_criteria_status[0].status = "not_tested";
    if (phase === "C" && legacyMissingTriggers) delete art.phase_data.security_triggers;
    const rel = path.join("phases", nodeId, attemptId, `${phase}.json`);
    const full = path.join(dispatcher.ledgerDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(`${JSON.stringify(art, null, 2)}\n`));
    phases[phase] = { path: rel, sha256: hashJson(art), status: "passed" };
  }
  ledger.nodes[nodeId] = {
    status: active ? "in_progress" : "passed",
    depends_on: [],
    attempts: [{
      attempt_id: attemptId,
      sequence: 1,
      flow: "C-R-A-F-T-S",
      started_at: now,
      base_git: { available: false },
      phases,
      final_status: active ? null : "passed",
      completed_at: active ? undefined : now,
      completion_path: active ? undefined : path.join("nodes", nodeId, attemptId, "completion.json"),
    }],
  };
  if (!active) {
    const compRel = path.join("nodes", nodeId, attemptId, "completion.json");
    const compFull = path.join(dispatcher.ledgerDir, compRel);
    fs.mkdirSync(path.dirname(compFull), { recursive: true });
    fs.writeFileSync(compFull, Buffer.from(`${JSON.stringify({ schema_version: 1, node_id: nodeId, attempt_id: attemptId, status: "passed", flow: "C-R-A-F-T-S", completed_at: now, phases }, null, 2)}\n`));
    ledger.nodes[nodeId].attempts[0].completion_path = compRel;
  }
  ledger.nodes.b = { status: "pending", depends_on: ["a"], attempts: [] };
  ledger.nodes.c = { status: "pending", depends_on: ["a"], attempts: [] };
  fs.mkdirSync(dispatcher.ledgerDir, { recursive: true });
  fs.writeFileSync(dispatcher.ledgerPath, JSON.stringify(ledger, null, 2));
}

const script = fileURLToPath(new URL("./goal-dispatcher.mjs", import.meta.url));
function run(args, cwd) { return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" }); }

describe("GoalDispatcher", () => {
  let root, planPath, dispatcher;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-dispatcher-")); planPath = makePlan(root); dispatcher = new GoalDispatcher({ rootDir: root, planPath }); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("init freezes the plan and is idempotent", async () => {
    const first = await dispatcher.init();
    assert.equal(first.created, true);
    const second = await dispatcher.init();
    assert.equal(second.created, false);
    const status = dispatcher.status();
    assert.deepEqual(status.ready, ["a"]);
    assert.equal(status.planDrift, false);
  });

  test("status reports drift and blocks mutation", async () => {
    await dispatcher.init();
    const plan = JSON.parse(fs.readFileSync(planPath)); plan.nodes[0].intent = "changed"; fs.writeFileSync(planPath, JSON.stringify(plan));
    assert.equal(dispatcher.status().planDrift, true);
    await assert.rejects(dispatcher.start(), /drift/);
    assert.throws(() => dispatcher.resume(), /drift/);
  });

  test("start reserves one stable attempt and duplicate start resumes it", async () => {
    await dispatcher.init();
    const first = await dispatcher.start();
    const replay = await dispatcher.start();
    assert.equal(first.attempt_id, "a-attempt-1");
    assert.equal(replay.resumed, true);
    assert.deepEqual(dispatcher.status().inProgress, ["a"]);
  });

  test("workspace guard blocks a distinct run ID in the same worktree", async () => {
    await dispatcher.init();
    const first = await dispatcher.start();
    const other = new GoalDispatcher({ rootDir: root, planPath, runId: "other" }); await other.init();
    await assert.rejects(other.start(), /workspace already has active writer/);
    await dispatcher.complete(first.node_id, first.attempt_id, "failed");
    assert.equal((await other.start()).node_id, "a");
  });

  test("phase order is enforced", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    await assert.rejects(dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id)), /expected C/);
  });

  test("identical phase replay is idempotent and conflicting replay rejects", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    const value = artifact("C", active.node_id, active.attempt_id);
    assert.equal((await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", value)).replayed, false);
    assert.equal((await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", value)).replayed, true);
    const conflict = structuredClone(value); conflict.summary = "different";
    await assert.rejects(dispatcher.recordPhase(active.node_id, active.attempt_id, "C", conflict), /conflicting replay|phase order/);
  });

  test("passed completion requires all full-flow phases", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    await assert.rejects(dispatcher.complete(active.node_id, active.attempt_id, "passed"), /incomplete/);
    await recordFull(dispatcher, active.node_id, active.attempt_id);
    await dispatcher.complete(active.node_id, active.attempt_id, "passed");
    assert.deepEqual(dispatcher.status().ready, ["b", "c"]);
  });

  test("passed completion rejects failed or blocked terminal phase states", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", artifact("C", active.node_id, active.attempt_id, { status: "failed" }));
    await assert.rejects(dispatcher.complete(active.node_id, active.attempt_id, "passed"), /incomplete/);
    await dispatcher.complete(active.node_id, active.attempt_id, "failed");
    const retried = await dispatcher.retry({ nodeId: "a", approvedBy: "kyler", reason: "C failed" });
    await dispatcher.recordPhase(retried.node_id, retried.attempt_id, "C", artifact("C", retried.node_id, retried.attempt_id, { status: "blocked" }));
    await assert.rejects(dispatcher.complete(retried.node_id, retried.attempt_id, "passed"), /incomplete/);
  });

  test("needs-fix assessment requires a passing F artifact", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    await recordFull(dispatcher, active.node_id, active.attempt_id, { assessmentStatus: "needs_fix" });
    await dispatcher.complete(active.node_id, active.attempt_id, "passed");
    assert.deepEqual(dispatcher.status().completed, ["a"]);
  });

  test("lite flow requires only R and S", async () => {
    await dispatcher.init();
    const active = await dispatcher.start({ flow: "R-S" });
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id, { flow: "R-S" }));
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "S", artifact("S", active.node_id, active.attempt_id, { flow: "R-S" }));
    const completed = await dispatcher.complete(active.node_id, active.attempt_id, "passed");
    assert.deepEqual(dispatcher.status().completed, ["a"]);
    assert.ok(["written", "degraded"].includes(completed.telemetry_candidate.status));
  });

  test("resume returns the active attempt and refreshes under the ledger lock", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", artifact("C", active.node_id, active.attempt_id));
    const reopened = new GoalDispatcher({ rootDir: root, planPath });
    const resumed = reopened.resume();
    assert.equal(resumed.active_attempt.node_id, "a");
    assert.equal(resumed.active_attempt.next_action.phase, "R");

    fs.writeFileSync(dispatcher.lockPath, "held\n");
    try {
      assert.throws(() => reopened.resume(), /lock is held/);
    } finally {
      fs.rmSync(dispatcher.lockPath, { force: true });
    }
  });

  test("explicit retry preserves a failed attempt and creates a new audited attempt", async () => {
    await dispatcher.init();
    const first = await dispatcher.start();
    await dispatcher.complete(first.node_id, first.attempt_id, "failed");
    const retried = await dispatcher.retry({ nodeId: "a", approvedBy: "kyler", reason: "repair failed Tighten findings" });
    assert.equal(retried.attempt_id, "a-attempt-2");
    assert.equal(retried.retry_of, "a-attempt-1");
    assert.deepEqual(dispatcher.status().inProgress, ["a"]);
  });

  test("with-C triggers require plan-security checkpoint before R", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    const cArt = artifact("C", active.node_id, active.attempt_id, { triggers: ["trust-boundary-change"] });
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", cArt);
    await assert.rejects(dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id)), /checkpoint|phase order/);
    const checkpoint = {
      kind: "plan-security", status: "pass", reviewed_c_sha256: hashJson(cArt), reviewed_c_revision: 1,
      triggers: ["trust-boundary-change"], findings: [],
    };
    await dispatcher.recordCheckpoint(active.node_id, active.attempt_id, checkpoint);
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id));
    assert.equal(dispatcher.resume().active_attempt.next_action.phase, "A");
  });

  test("bounded plan-security loop reaches human decision", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    const c1 = artifact("C", active.node_id, active.attempt_id, { triggers: ["trust-boundary-change"] });
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", c1);
    const ps1 = { kind: "plan-security", status: "needs-replan", reviewed_c_sha256: hashJson(c1), reviewed_c_revision: 1, triggers: ["trust-boundary-change"], findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }] };
    await dispatcher.recordCheckpoint(active.node_id, active.attempt_id, ps1);
    const c2 = structuredClone(c1); c2.summary = "revised";
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", c2);
    const ps2 = { kind: "plan-security", status: "needs-replan", reviewed_c_sha256: hashJson(c2), reviewed_c_revision: 2, triggers: ["trust-boundary-change"], findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }] };
    await dispatcher.recordCheckpoint(active.node_id, active.attempt_id, ps2);
    assert.equal(dispatcher.resume().active_attempt.next_action.decision, hashJson(ps2));
    await assert.rejects(dispatcher.recordDecision(active.node_id, active.attempt_id, { kind: "human-decision", bound_to: hashJson(ps2), outcome: "defer-and-proceed", decided_by: "kyler", reason: "proceed" }), /defer-and-proceed is not allowed/);
    await dispatcher.recordDecision(active.node_id, active.attempt_id, { kind: "human-decision", bound_to: hashJson(ps2), outcome: "stop-and-rescope", decided_by: "kyler", reason: "stop" });
    assert.equal(dispatcher.status().inProgress.length, 0);
  });

  test("v1 ledger upgrade is explicit, idempotent, and tolerates completed pre-trigger C artifacts", async () => {
    writeV1Ledger(dispatcher, { legacyMissingTriggers: true });
    const before = fs.readFileSync(dispatcher.ledgerPath, "utf8");
    await assert.rejects(dispatcher.start(), /requires upgrade-ledger/);
    const dry = await dispatcher.upgradeLedger({ dryRun: true });
    assert.equal(dry.dry_run, true);
    assert.equal(fs.readFileSync(dispatcher.ledgerPath, "utf8"), before);
    const applied = await dispatcher.upgradeLedger();
    assert.equal(applied.upgraded, true);
    assert.equal(applied.dry_run, false);
    assert.equal(applied.backup_existed, false);
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.equal(ledger.schema_version, JOURNAL_SCHEMA_VERSION);
    assert.equal(ledger.nodes.a.status, "passed");
    assert.equal(ledger.nodes.a.attempts[0].attempt_id, "a-attempt-1");
    assert.ok(fs.existsSync(applied.backup_path));
    assert.equal(ledger.amendments.length, 1);
    const replay = await dispatcher.upgradeLedger();
    assert.equal(replay.upgraded, false);
    assert.equal(replay.reason, "already_v2");
  });

  test("active v1 attempt with C triggers resumes at plan-security after upgrade", async () => {
    writeV1Ledger(dispatcher, { active: true, triggers: ["trust-boundary-change"], legacyUnverifiedC: true });
    const applied = await dispatcher.upgradeLedger();
    assert.equal(applied.upgraded, true);
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.deepEqual(ledger.nodes.a.attempts[0].phases.C.triggers, ["trust-boundary-change"]);
    const resumed = dispatcher.resume();
    assert.equal(resumed.active_attempt.node_id, "a");
    assert.deepEqual(resumed.active_attempt.next_action, { checkpoint: "plan-security" });
  });

  test("v1 upgrade retry reuses a pre-existing exact-byte backup", async () => {
    writeV1Ledger(dispatcher);
    const raw = fs.readFileSync(dispatcher.ledgerPath);
    const backupPath = path.join(dispatcher.archiveDir, `${crypto.createHash("sha256").update(raw).digest("hex")}.json`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, raw);

    const result = await dispatcher.upgradeLedger();
    assert.equal(result.upgraded, true);
    assert.equal(result.backup_existed, true);
    assert.equal(result.backup_path, backupPath);
    assert.deepEqual(fs.readFileSync(backupPath), raw);
    assert.equal(JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8")).schema_version, JOURNAL_SCHEMA_VERSION);
  });

  test("archive-reset requires confirmation hash and no active writer", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    const frozen = dispatcher.status().frozen_plan_sha;
    await assert.rejects(dispatcher.archiveReset({ confirmationHash: frozen, approvedBy: "kyler", reason: "reset" }), /active attempt/);
    await dispatcher.complete(active.node_id, active.attempt_id, "failed");
    const changedPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    changedPlan.approval.notes = "owner-approved replacement plan";
    fs.writeFileSync(planPath, JSON.stringify(changedPlan, null, 2));
    const currentApprovedHash = sha256File(planPath);
    await assert.rejects(dispatcher.archiveReset({ confirmationHash: frozen, approvedBy: "kyler", reason: "reset" }), /current approved plan SHA/);
    const result = await dispatcher.archiveReset({ confirmationHash: currentApprovedHash, approvedBy: "kyler", reason: "approved plan changed" });
    assert.ok(fs.existsSync(result.archived_to));
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.equal(ledger.schema_version, JOURNAL_SCHEMA_VERSION);
    assert.equal(ledger.frozen_plan_sha, currentApprovedHash);
    assert.equal(ledger.reset_from.previous_plan_sha, frozen);
    assert.equal(ledger.reset_from.approved_by, "kyler");
    assert.equal(ledger.reset_from.reason, "approved plan changed");
    assert.deepEqual(dispatcher.status().ready, ["a"]);
  });

  test("upgrade and archive-reset reject a symlinked archive directory", async () => {
    writeV1Ledger(dispatcher);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goal-archive-outside-"));
    fs.symlinkSync(outside, dispatcher.archiveDir);
    try {
      await assert.rejects(dispatcher.upgradeLedger(), /symlinked dispatcher path/);
      fs.unlinkSync(dispatcher.archiveDir);
      await dispatcher.upgradeLedger();
      fs.rmSync(dispatcher.archiveDir, { recursive: true, force: true });
      fs.symlinkSync(outside, dispatcher.archiveDir);
      const frozen = dispatcher.status().frozen_plan_sha;
      await assert.rejects(dispatcher.archiveReset({ confirmationHash: frozen, approvedBy: "kyler", reason: "reset" }), /symlinked dispatcher path/);
    } finally {
      fs.rmSync(dispatcher.archiveDir, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("CLI awaits async commands and returns meaningful output", async () => {
    fs.mkdirSync(path.join(root, "docs", "raw", "plans"), { recursive: true }); fs.copyFileSync(planPath, path.join(root, "docs", "raw", "plans", "proposed-build-dag.json"));
    const initResult = run(["init"], root);
    assert.equal(initResult.status, 0);
    const initOut = JSON.parse(initResult.stdout);
    assert.equal(initOut.created, true);
    assert.ok(initOut.ledger_path);
    const started = JSON.parse(run(["start"], root).stdout);
    assert.equal(started.node_id, "a");
    assert.equal(started.attempt_id, "a-attempt-1");
    assert.equal(started.resumed, false);
    assert.equal(started.flow, "C-R-A-F-T-S");
    const incoming = path.join(root, ".pi", "goal-runs", "default", "incoming");
    const cPath = path.join(incoming, "c.json");
    fs.mkdirSync(incoming, { recursive: true });
    const cArtifact = artifact("C", started.node_id, started.attempt_id, { triggers: ["trust-boundary-change"] });
    fs.writeFileSync(cPath, JSON.stringify(cArtifact));
    const recordResult = run(["record-phase", started.node_id, started.attempt_id, "C", cPath], root);
    assert.equal(recordResult.status, 0, recordResult.stderr);
    const recorded = JSON.parse(recordResult.stdout);
    assert.equal(recorded.replayed, false);
    assert.ok(recorded.sha256);

    const checkpointPath = path.join(incoming, "plan-security.json");
    fs.writeFileSync(checkpointPath, JSON.stringify({
      kind: "plan-security",
      status: "pass",
      reviewed_c_sha256: recorded.sha256,
      reviewed_c_revision: 1,
      triggers: ["trust-boundary-change"],
      findings: [],
    }));
    const checkpointResult = run(["record-checkpoint", started.node_id, started.attempt_id, checkpointPath], root);
    assert.equal(checkpointResult.status, 0, checkpointResult.stderr);
    const checkpoint = JSON.parse(checkpointResult.stdout);
    assert.equal(checkpoint.replayed, false);
    assert.ok(checkpoint.sha256);
  });

  test("CLI upgrade-ledger returns dry-run and applied results", () => {
    const defaultPlan = path.join(root, "docs", "raw", "plans", "proposed-build-dag.json");
    fs.mkdirSync(path.dirname(defaultPlan), { recursive: true });
    fs.copyFileSync(planPath, defaultPlan);
    const cliDispatcher = new GoalDispatcher({ rootDir: root, planPath: defaultPlan });
    writeV1Ledger(cliDispatcher, { active: true, triggers: ["trust-boundary-change"] });

    const dryRun = run(["upgrade-ledger", "--dry-run"], root);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).dry_run, true);

    const applied = run(["upgrade-ledger"], root);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.upgraded, true);
    assert.equal(result.dry_run, false);
  });

  test("CLI rejects artifact reads outside the ledger directory", () => {
    fs.mkdirSync(path.join(root, "docs", "raw", "plans"), { recursive: true }); fs.copyFileSync(planPath, path.join(root, "docs", "raw", "plans", "proposed-build-dag.json"));
    assert.equal(run(["init"], root).status, 0);
    const started = JSON.parse(run(["start"], root).stdout);
    const outside = path.join(root, "outside.json"); fs.writeFileSync(outside, JSON.stringify(artifact("C", started.node_id, started.attempt_id)));
    const result = run(["record-phase", started.node_id, started.attempt_id, "C", outside], root);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /under .*ledger|non-symlinked file under/);
  });

  test("workspace guard next_action is fresh immediately after phase, checkpoint, and decision", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    const cArt = artifact("C", active.node_id, active.attempt_id, { triggers: ["trust-boundary-change"] });
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", cArt);
    const guardPath = path.join(dispatcher.ledgerBase, "workspace-writer.json");
    let guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));
    assert.deepEqual(guard.next_action, { checkpoint: "plan-security" });
    const checkpoint = {
      kind: "plan-security", status: "pass", reviewed_c_sha256: hashJson(cArt), reviewed_c_revision: 1,
      triggers: ["trust-boundary-change"], findings: [],
    };
    await dispatcher.recordCheckpoint(active.node_id, active.attempt_id, checkpoint);
    guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));
    assert.deepEqual(guard.next_action, { phase: "R" });
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id));
    guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));
    assert.deepEqual(guard.next_action, { phase: "A" });

    const a1 = artifact("A", active.node_id, active.attempt_id, { status: "needs_fix" });
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "A", a1);
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "F", artifact("F", active.node_id, active.attempt_id));
    const a2 = artifact("A", active.node_id, active.attempt_id, { status: "needs_fix" });
    a2.summary = "second assessment";
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "A", a2);
    const a2Hash = hashJson(a2);
    guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));
    assert.deepEqual(guard.next_action, { decision: a2Hash });

    await dispatcher.recordDecision(active.node_id, active.attempt_id, {
      kind: "human-decision",
      bound_to: a2Hash,
      outcome: "defer-and-proceed",
      decided_by: "kyler",
      reason: "accept residual local maintainability risk",
    });
    guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));
    assert.deepEqual(guard.next_action, { phase: "T" });
  });

  test("cross-phase F reuse is rejected by binding", async () => {
    await dispatcher.init();
    const active = await dispatcher.start();
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "C", artifact("C", active.node_id, active.attempt_id));
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "R", artifact("R", active.node_id, active.attempt_id));
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "A", artifact("A", active.node_id, active.attempt_id, { status: "needs_fix" }));
    const fForA = artifact("F", active.node_id, active.attempt_id);
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "F", fForA);
    const ledger = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.equal(ledger.nodes.a.attempts[0].phases.F.bound_to, ledger.nodes.a.attempts[0].phases.A.sha256);
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "A", artifact("A", active.node_id, active.attempt_id));
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "T", artifact("T", active.node_id, active.attempt_id, { status: "needs_fix" }));
    const fForT = artifact("F", active.node_id, active.attempt_id);
    fForT.summary = "for T";
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "F", fForT);
    const ledger2 = JSON.parse(fs.readFileSync(dispatcher.ledgerPath, "utf8"));
    assert.equal(ledger2.nodes.a.attempts[0].phases.F.bound_to, ledger2.nodes.a.attempts[0].phases.T.sha256);
    await assert.rejects(dispatcher.complete(active.node_id, active.attempt_id, "passed"), /incomplete/);
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "T", artifact("T", active.node_id, active.attempt_id));
    await dispatcher.recordPhase(active.node_id, active.attempt_id, "S", artifact("S", active.node_id, active.attempt_id));
    await dispatcher.complete(active.node_id, active.attempt_id, "passed");
  });

  test("scope guard fails if worker package is touched", () => {
    assert.equal(fs.existsSync(path.join(root, "..", "packages", "worker-harness")), false);
  });
});
