import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  assertCanComplete,
  assertCanRecordCheckpoint,
  assertCanRecordDecision,
  assertCanRecordPhase,
  boundFixTarget,
  computeFrontier,
  hashJson,
  JOURNAL_SCHEMA_VERSION,
  nextAction,
  normalizeLedger,
  validateCheckpoint,
  validateDecision,
  validatePhaseArtifact,
} from "./goal-journal.mjs";

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
function artifact(phase, nodeId, attemptId, { status = "passed", flow = "C-R-A-F-T-S", triggers = [] } = {}) {
  return {
    schema_version: 1, node_id: nodeId, attempt_id: attemptId, phase, status,
    model: "test/model", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), summary: "artifact",
    acceptance_criteria_status: [{ criterion: "criterion", status: status === "passed" ? "met" : "unmet", evidence: [] }],
    changed_files: ["file"].filter(() => !["C", "A", "T"].includes(phase)), commands_run: [],
    cost: { input_tokens: 0, output_tokens: 0, amount: null, currency: null }, risks: [], open_questions: [],
    recommended_next_step: "next", failure_context: status === "passed" ? null : { attempted: [], failure_reason: "fix", discoveries: [], dead_ends: [] },
    transcript_path: null, phase_data: phaseData(phase, flow, triggers),
  };
}
function makeAttempt({ flow = "C-R-A-F-T-S", phases = {}, checkpoints = [], decisions = [], attemptId = "a-attempt-1" } = {}) {
  return { attempt_id: attemptId, sequence: 1, flow, started_at: new Date().toISOString(), base_git: { available: false }, phases, phase_history: {}, checkpoints, decisions, final_status: null };
}
function record(dispatcherLike, attempt, phase, art, { triggers } = {}) {
  const digest = hashJson(art);
  const revision = (attempt.phase_history?.[phase]?.length || 0) + (attempt.phases?.[phase] ? 1 : 0) + 1;
  const fileName = revision === 1 ? `${phase}.json` : `${phase}-${revision}.json`;
  const record = { path: `phases/a/${attempt.attempt_id}/${fileName}`, sha256: digest, status: art.status, recorded_at: new Date().toISOString() };
  if (phase === "C") record.triggers = triggers || art.phase_data.security_triggers;
  if (phase === "F") {
    const target = boundFixTarget(attempt);
    if (target) record.bound_to = target.sha256;
  }
  attempt.phases ||= {};
  attempt.phase_history ||= {};
  attempt.phase_history[phase] = [...(attempt.phase_history[phase] || []), attempt.phases[phase]].filter(Boolean);
  attempt.phases[phase] = record;
  return record;
}

function checkpointRecord(kind, status, overrides = {}) {
  const base = { kind, status, reviewed_c_sha256: "c".repeat(64), reviewed_c_revision: 1, triggers: [], path: `checkpoints/a/a-attempt-1/${kind}-1.json`, sha256: "p".repeat(64), recorded_at: new Date().toISOString() };
  return { ...base, ...overrides };
}

function decisionInput(target, overrides = {}) {
  return { kind: "human-decision", attempt_id: "a-attempt-1", target, outcome: "defer-and-proceed", decided_by: "kyler", reason: "reason", ...overrides };
}
function decisionRecord(target, overrides = {}) {
  return { ...decisionInput(target), path: "decisions/a/a-attempt-1/decision-1.json", sha256: "d".repeat(64), recorded_at: new Date().toISOString(), ...overrides };
}
const legacyDecisionRecord = (boundTo, overrides = {}) => ({ kind: "human-decision", bound_to: boundTo, outcome: "defer-and-proceed", decided_by: "kyler", reason: "reason", path: "decisions/a/a-attempt-1/decision-1.json", sha256: "d".repeat(64), recorded_at: new Date().toISOString(), ...overrides });

describe("goal-journal", () => {
  test("normalizeLedger upgrades to the current schema and fills defaults", () => {
    const ledger = normalizeLedger({ run_id: "default" });
    assert.equal(ledger.schema_version, JOURNAL_SCHEMA_VERSION);
    assert.deepEqual(ledger.nodes, {});
    assert.deepEqual(ledger.amendments, []);
  });

  test("computeFrontier derives ready, blocked, and completed sets", () => {
    const ledger = normalizeLedger({
      nodes: {
        a: { status: "passed", depends_on: [], attempts: [] },
        b: { status: "failed", depends_on: [], attempts: [] },
        c: { status: "pending", depends_on: ["b"], attempts: [] },
        d: { status: "pending", depends_on: ["a"], attempts: [] },
      },
    });
    const frontier = computeFrontier(ledger);
    assert.deepEqual(frontier.completed, ["a"]);
    assert.deepEqual(frontier.failed, ["b"]);
    assert.deepEqual(frontier.blocked, ["c"]);
    assert.deepEqual(frontier.ready, ["d"]);
  });

  test("nextAction R-S flow requests R then S", () => {
    const attempt = makeAttempt({ flow: "R-S" });
    assert.deepEqual(nextAction(attempt), { phase: "R" });
    record({}, attempt, "R", artifact("R", "a", "a-attempt-1", { flow: "R-S" }));
    assert.deepEqual(nextAction(attempt), { phase: "S" });
    record({}, attempt, "S", artifact("S", "a", "a-attempt-1", { flow: "R-S" }));
    assert.deepEqual(nextAction(attempt), { complete: true });
  });

  test("nextAction with-C starts undecided at C", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    assert.deepEqual(nextAction(attempt), { phase: "C" });
  });

  test("nextAction C with no triggers selects R", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
    assert.deepEqual(nextAction(attempt), { phase: "R" });
  });

  test("nextAction C with triggers selects plan-security", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    record({}, attempt, "C", artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] }), { triggers: ["trust-boundary-change"] });
    assert.deepEqual(nextAction(attempt), { checkpoint: "plan-security" });
  });

  test("nextAction plan-security pass proceeds to R", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    const cArt = artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] });
    record({}, attempt, "C", cArt, { triggers: ["trust-boundary-change"] });
    const cRecord = attempt.phases.C;
    attempt.checkpoints.push(checkpointRecord("plan-security", "pass", { reviewed_c_sha256: cRecord.sha256, triggers: ["trust-boundary-change"] }));
    assert.deepEqual(nextAction(attempt), { phase: "R" });
  });

  test("nextAction plan-security needs-replan allows one C revision", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    const cArt = artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] });
    record({}, attempt, "C", cArt, { triggers: ["trust-boundary-change"] });
    const cRecord = attempt.phases.C;
    attempt.checkpoints.push(checkpointRecord("plan-security", "needs-replan", { reviewed_c_sha256: cRecord.sha256, triggers: ["trust-boundary-change"], findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }] }));
    assert.deepEqual(nextAction(attempt), { phase: "C" });
  });

  test("nextAction second plan-security needs-replan expects an attempt-scoped checkpoint decision target", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    const c1 = artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] });
    record({}, attempt, "C", c1, { triggers: ["trust-boundary-change"] });
    attempt.checkpoints.push(checkpointRecord("plan-security", "needs-replan", { reviewed_c_sha256: attempt.phases.C.sha256, triggers: ["trust-boundary-change"], findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }] }));
    const c2 = artifact("C", "a", "a-attempt-1", { status: "passed", triggers: ["trust-boundary-change"] });
    c2.summary = "revised";
    record({}, attempt, "C", c2, { triggers: ["trust-boundary-change"] });
    const ps2 = checkpointRecord("plan-security", "needs-replan", { reviewed_c_sha256: attempt.phases.C.sha256, reviewed_c_revision: 2, triggers: ["trust-boundary-change"], findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }] });
    attempt.checkpoints.push(ps2);
    assert.deepEqual(nextAction(attempt), { decision: { type: "checkpoint", name: "plan-security", revision: 2 } });
  });

  test("defer-and-proceed rejected for critical/high plan-security findings", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    const c1 = artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] });
    record({}, attempt, "C", c1, { triggers: ["trust-boundary-change"] });
    const ps1 = checkpointRecord("plan-security", "needs-replan", { reviewed_c_sha256: attempt.phases.C.sha256, triggers: ["trust-boundary-change"], findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }] });
    attempt.checkpoints.push(ps1);
    record({}, attempt, "C", artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] }), { triggers: ["trust-boundary-change"] });
    const ps2 = checkpointRecord("plan-security", "needs-replan", { reviewed_c_sha256: attempt.phases.C.sha256, reviewed_c_revision: 2, triggers: ["trust-boundary-change"], findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }] });
    attempt.checkpoints.push(ps2);
    attempt.decisions.push(decisionRecord({ type: "checkpoint", name: "plan-security", revision: 2 }, { outcome: "defer-and-proceed" }));
    assert.throws(() => nextAction(attempt), /defer-and-proceed is not allowed/);
  });

  test("bounded A/F/A loop reaches an attempt-scoped phase decision target", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
    record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
    record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
    assert.deepEqual(nextAction(attempt), { phase: "F" });
    record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
    assert.deepEqual(nextAction(attempt), { phase: "A" });
    const a2 = artifact("A", "a", "a-attempt-1", { status: "needs_fix" });
    a2.summary = "second";
    record({}, attempt, "A", a2);
    assert.deepEqual(nextAction(attempt), { decision: { type: "phase", name: "A", revision: 2 } });
  });

  test("bounded T/F/T loop reaches an attempt-scoped phase decision target", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
    record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
    record({}, attempt, "A", artifact("A", "a", "a-attempt-1"));
    record({}, attempt, "T", artifact("T", "a", "a-attempt-1", { status: "needs_fix" }));
    assert.deepEqual(nextAction(attempt), { phase: "F" });
    record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
    assert.deepEqual(nextAction(attempt), { phase: "T" });
    const t2 = artifact("T", "a", "a-attempt-1", { status: "needs_fix" });
    t2.summary = "second";
    record({}, attempt, "T", t2);
    assert.deepEqual(nextAction(attempt), { decision: { type: "phase", name: "T", revision: 2 } });
  });

  test("C non-passing is revisable up to a bounded human decision", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    const c1 = artifact("C", "a", "a-attempt-1", { status: "needs_fix" });
    record({}, attempt, "C", c1);
    assert.deepEqual(nextAction(attempt), { phase: "C" });
    const c2 = artifact("C", "a", "a-attempt-1", { status: "needs_fix" });
    c2.summary = "revised";
    record({}, attempt, "C", c2);
    assert.deepEqual(nextAction(attempt), { decision: { type: "phase", name: "C", revision: 2 } });
  });

  test("R-S non-passing is revisable up to a bounded human decision", () => {
    const attempt = makeAttempt({ flow: "R-S" });
    const r1 = artifact("R", "a", "a-attempt-1", { status: "needs_fix", flow: "R-S" });
    record({}, attempt, "R", r1);
    assert.deepEqual(nextAction(attempt), { phase: "R" });
    const r2 = artifact("R", "a", "a-attempt-1", { status: "needs_fix", flow: "R-S" });
    r2.summary = "revised";
    record({}, attempt, "R", r2);
    assert.deepEqual(nextAction(attempt), { decision: { type: "phase", name: "R", revision: 2 } });
  });

  test("F revision is bound to the specific A or T review that requested it", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
    record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
    const a1 = artifact("A", "a", "a-attempt-1", { status: "needs_fix" });
    record({}, attempt, "A", a1);
    const fForA = artifact("F", "a", "a-attempt-1");
    record({}, attempt, "F", fForA);
    assert.equal(attempt.phases.F.bound_to, attempt.phases.A.sha256);
    assert.deepEqual(nextAction(attempt), { phase: "A" });
    record({}, attempt, "A", artifact("A", "a", "a-attempt-1"));
    const t1 = artifact("T", "a", "a-attempt-1", { status: "needs_fix" });
    record({}, attempt, "T", t1);
    assert.deepEqual(nextAction(attempt), { phase: "F" });
    const fForT = artifact("F", "a", "a-attempt-1");
    fForT.summary = "for T";
    record({}, attempt, "F", fForT);
    assert.equal(attempt.phases.F.bound_to, attempt.phases.T.sha256);
    assert.deepEqual(nextAction(attempt), { phase: "T" });
  });

  test("assertCanRecordPhase rejects unsolicited phase", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    assert.throws(() => assertCanRecordPhase(attempt, "R", hashJson(artifact("R", "a", "a-attempt-1"))), /expected C/);
  });

  test("assertCanComplete rejects passed until flow complete", () => {
    const attempt = makeAttempt({ flow: "R-S" });
    assert.throws(() => assertCanComplete(attempt, "passed"), /incomplete/);
  });

  test("validateCheckpoint rejects wrong C hash or trigger set", () => {
    const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
    record({}, attempt, "C", artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] }), { triggers: ["trust-boundary-change"] });
    assert.throws(() => validateCheckpoint(checkpointRecord("plan-security", "pass", { reviewed_c_sha256: "0".repeat(64) }), { attempt }), /does not match/);
    assert.throws(() => validateCheckpoint(checkpointRecord("plan-security", "pass", {
      reviewed_c_sha256: attempt.phases.C.sha256,
      triggers: [],
    }), { attempt }), /triggers do not match/);
    assert.throws(() => validateCheckpoint(checkpointRecord("plan-security", "pass", {
      reviewed_c_sha256: attempt.phases.C.sha256,
      triggers: ["trust-boundary-change"],
      findings: [{ severity: "high", finding: "x", exploitability: "y", smallestSafeFix: "z" }],
    }), { attempt }), /cannot contain blocking findings/);
  });

  test("planning may leave criteria untested while passed post-plan artifacts cannot carry failing verdicts", () => {
    const c = artifact("C", "a", "a-attempt-1");
    c.acceptance_criteria_status[0].status = "not_tested";
    assert.doesNotThrow(() => validatePhaseArtifact(c, { nodeId: "a", attemptId: "a-attempt-1", phase: "C", acceptanceCriteria: ["criterion"] }));

    const r = artifact("R", "a", "a-attempt-1");
    r.acceptance_criteria_status[0].status = "unknown";
    assert.throws(() => validatePhaseArtifact(r, { nodeId: "a", attemptId: "a-attempt-1", phase: "R", acceptanceCriteria: ["criterion"] }), /post-plan artifact must mark every acceptance criterion met/);

    const a = artifact("A", "a", "a-attempt-1");
    a.phase_data.criteria_fit.passed = false;
    assert.throws(() => validatePhaseArtifact(a, { nodeId: "a", attemptId: "a-attempt-1", phase: "A", acceptanceCriteria: ["criterion"] }), /requires criteria fit/);

    const t = artifact("T", "a", "a-attempt-1");
    t.phase_data.security_findings = [{ severity: "high", message: "blocker", evidence: ["file:1"] }];
    assert.throws(() => validatePhaseArtifact(t, { nodeId: "a", attemptId: "a-attempt-1", phase: "T", acceptanceCriteria: ["criterion"] }), /cannot contain critical or high/);
  });

  describe("direct attempt-scoped human decisions", () => {
    test("validateDecision accepts the exact direct schema for an exhausted A review", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      const decision = decisionInput({ type: "phase", name: "A", revision: 2 });
      assert.equal(validateDecision(decision, { attempt }), decision);
    });

    test("validateDecision rejects a mismatched attempt_id", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: 2 }, { attempt_id: "other-attempt" }), { attempt }), /attempt_id/);
    });

    test("validateDecision rejects unknown fields, malformed targets, and blank actor/reason", () => {
      const attempt = makeAttempt();
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: 1 }, { extra: 1 }), { attempt }), /unknown fields/);
      assert.throws(() => validateDecision({ kind: "human-decision", attempt_id: "a-attempt-1", bound_to: "a".repeat(64), outcome: "defer-and-proceed", decided_by: "kyler", reason: "r" }, { attempt }), /bound_to|missing or unknown/);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A" }), { attempt }), /target/);
      assert.throws(() => validateDecision(decisionInput({ type: "suite", name: "A", revision: 1 }), { attempt }), /target type/);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "B", revision: 1 }), { attempt }), /target phase/);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: 0 }), { attempt }), /target revision/);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: "2" }), { attempt }), /target revision/);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: 1 }, { decided_by: "  " }), { attempt }), /decided_by/);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: 1 }, { reason: "" }), { attempt }), /reason/);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: 1 }, { outcome: "proceed" }), { attempt }), /outcome is invalid/);
    });

    test("validateDecision rejects defer-and-proceed outside exhausted A/T reviews", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      const c1 = artifact("C", "a", "a-attempt-1", { status: "needs_fix" });
      record({}, attempt, "C", c1);
      const c2 = artifact("C", "a", "a-attempt-1", { status: "needs_fix" });
      c2.summary = "revised";
      record({}, attempt, "C", c2);
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "C", revision: 2 }), { attempt }), /only for exhausted A or T/);

      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "passed" }));
      assert.throws(() => validateDecision(decisionInput({ type: "phase", name: "A", revision: 1 }), { attempt }), /only for exhausted A or T/);
    });

    test("assertCanRecordDecision requires exact structural equality with the expected target", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      assert.ok(assertCanRecordDecision(attempt, decisionInput({ type: "phase", name: "A", revision: 2 })));
      assert.throws(() => assertCanRecordDecision(attempt, decisionInput({ type: "phase", name: "A", revision: 1 })), /no human decision is expected/);
      assert.throws(() => assertCanRecordDecision(attempt, decisionInput({ type: "phase", name: "T", revision: 2 })), /no human decision is expected/);
      assert.throws(() => assertCanRecordDecision(attempt, decisionInput({ type: "checkpoint", name: "plan-security", revision: 2 })), /no human decision is expected/);
    });

    test("assertCanRecordDecision rejects a non-exhausted target", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      assert.throws(() => assertCanRecordDecision(attempt, decisionInput({ type: "phase", name: "A", revision: 1 })), /no human decision is expected/);
    });

    test("a recorded direct decision unblocks the exhausted phase", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      attempt.decisions.push(decisionRecord({ type: "phase", name: "A", revision: 2 }, { outcome: "defer-and-proceed" }));
      assert.deepEqual(nextAction(attempt), { phase: "T" });
    });

    test("F binds to a later T needs_fix rather than a deferred A, and the loop completes", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      assert.deepEqual(nextAction(attempt), { phase: "F" });
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      assert.deepEqual(nextAction(attempt), { phase: "A" });
      const a2 = artifact("A", "a", "a-attempt-1", { status: "needs_fix" });
      a2.summary = "second";
      record({}, attempt, "A", a2);
      assert.deepEqual(nextAction(attempt), { decision: { type: "phase", name: "A", revision: 2 } });
      attempt.decisions.push(decisionRecord({ type: "phase", name: "A", revision: 2 }, { outcome: "defer-and-proceed" }));
      assert.deepEqual(nextAction(attempt), { phase: "T" });

      // The deferred A revision no longer requests a fix; a subsequent T needs_fix must bind F.
      const t1 = artifact("T", "a", "a-attempt-1", { status: "needs_fix" });
      record({}, attempt, "T", t1);
      const t1Sha = attempt.phases.T.sha256;
      assert.equal(boundFixTarget(attempt)?.sha256, t1Sha);
      assert.notEqual(boundFixTarget(attempt)?.sha256, attempt.phases.A.sha256);
      assert.deepEqual(nextAction(attempt), { phase: "F" });
      const fForT = artifact("F", "a", "a-attempt-1");
      fForT.summary = "for T";
      record({}, attempt, "F", fForT);
      assert.equal(attempt.phases.F.bound_to, t1Sha);
      assert.notEqual(attempt.phases.F.bound_to, attempt.phases.A.sha256);

      // The bound fix satisfies T revision 1 and the bounded loop completes without new decisions.
      assert.deepEqual(nextAction(attempt), { phase: "T" });
      const t2 = artifact("T", "a", "a-attempt-1");
      t2.summary = "second";
      record({}, attempt, "T", t2);
      assert.deepEqual(nextAction(attempt), { phase: "S" });
      record({}, attempt, "S", artifact("S", "a", "a-attempt-1"));
      assert.deepEqual(nextAction(attempt), { complete: true });
    });

    test("phaseEffectivelyPassed honors a defer decision recorded against a non-A/T phase", () => {
      const attempt = makeAttempt({ flow: "R-S" });
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1", { status: "needs_fix", flow: "R-S" }));
      attempt.decisions.push(decisionRecord({ type: "phase", name: "R", revision: 1 }, { outcome: "defer-and-proceed" }));
      assert.deepEqual(nextAction(attempt), { phase: "S" });
    });

    test("a stop-and-rescope direct decision terminates the loop", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      attempt.decisions.push(decisionRecord({ type: "phase", name: "A", revision: 2 }, { outcome: "stop-and-rescope" }));
      assert.deepEqual(nextAction(attempt), { outcome: "stop-and-rescope" });
    });
  });

  describe("legacy hash-bound decisions", () => {
    test("a legacy bound_to decision still unblocks the matching exhausted review", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      const a2 = artifact("A", "a", "a-attempt-1", { status: "needs_fix" });
      a2.summary = "second";
      record({}, attempt, "A", a2);
      attempt.decisions.push(legacyDecisionRecord(attempt.phases.A.sha256));
      assert.deepEqual(nextAction(attempt), { phase: "T" });
    });

    test("a legacy bound_to decision does not authorize a different target", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1"));
      record({}, attempt, "R", artifact("R", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      record({}, attempt, "F", artifact("F", "a", "a-attempt-1"));
      record({}, attempt, "A", artifact("A", "a", "a-attempt-1", { status: "needs_fix" }));
      attempt.decisions.push(legacyDecisionRecord("0".repeat(64)));
      assert.deepEqual(nextAction(attempt), { decision: { type: "phase", name: "A", revision: 2 } });
    });

    test("a legacy plan-security checkpoint decision still resolves", () => {
      const attempt = makeAttempt({ flow: "C-R-A-F-T-S" });
      const c1 = artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] });
      record({}, attempt, "C", c1, { triggers: ["trust-boundary-change"] });
      const ps1 = checkpointRecord("plan-security", "needs-replan", { reviewed_c_sha256: attempt.phases.C.sha256, triggers: ["trust-boundary-change"], findings: [{ severity: "low", finding: "x", exploitability: "y", smallestSafeFix: "z" }] });
      attempt.checkpoints.push(ps1);
      record({}, attempt, "C", artifact("C", "a", "a-attempt-1", { triggers: ["trust-boundary-change"] }), { triggers: ["trust-boundary-change"] });
      const ps2 = checkpointRecord("plan-security", "needs-replan", { reviewed_c_sha256: attempt.phases.C.sha256, reviewed_c_revision: 2, triggers: ["trust-boundary-change"], findings: [{ severity: "low", finding: "x", exploitability: "y", smallestSafeFix: "z" }], sha256: "b".repeat(64) });
      attempt.checkpoints.push(ps2);
      attempt.decisions.push(legacyDecisionRecord(ps2.sha256));
      assert.deepEqual(nextAction(attempt), { phase: "R" });
    });
  });
});
