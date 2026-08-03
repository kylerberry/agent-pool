import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  METHODOLOGY,
  TelemetryCollector,
  emitEvalCandidate,
  hashValue,
  normalizeUsage,
  resolveAssociation,
} from "../extensions/eval-telemetry/core.mjs";

const SECRET = "SUPER_SECRET_PROMPT_VALUE";
const criterion = "A works";
function plan() {
  return { schema_version: 1, nodes: [{ id: "a", intent: "A", change_spec: "Do A", acceptance_criteria: [criterion], depends_on: [] }], approval: { approved_by: "test", approved_at: new Date().toISOString() } };
}
// Kept explicit instead of helper magic so fixtures mirror the trusted files.
import crypto from "node:crypto";
function fixture(root, { agent = "local-craft-planner", phases = {}, flow = "C-R-A-F-T-S" } = {}) {
  const planPath = path.join(root, "docs/raw/plans/proposed-build-dag.json");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan()));
  const frozen = crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex");
  const runDir = path.join(root, ".pi/goal-runs/default");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(root, ".pi/goal-runs/workspace-writer.json"), JSON.stringify({ run_id: "default", node_id: "a", attempt_id: "a-attempt-1", workspace: fs.realpathSync(root), next_action: { phase: agent === "local-craft-planner" ? "C" : "R" } }));
  const attempt = { attempt_id: "a-attempt-1", flow, phases, final_status: null };
  const ledger = { frozen_plan_sha: frozen, plan_path: "docs/raw/plans/proposed-build-dag.json", nodes: { a: { status: "in_progress", depends_on: [], attempts: [attempt] } } };
  fs.writeFileSync(path.join(runDir, "ledger.json"), JSON.stringify(ledger));
  return { env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: agent }, ledger, attempt, plan: plan() };
}

function readTree(root) {
  const chunks = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else chunks.push(fs.readFileSync(target, "utf8"));
    }
  };
  walk(root);
  return chunks.join("\n");
}

describe("eval telemetry core", () => {
  let root;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-telemetry-"))); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("association comes only from matching child env, guard, ledger, and plan", () => {
    const { env } = fixture(root);
    const associated = resolveAssociation(root, env);
    assert.equal(associated.associated, true);
    assert.deepEqual({ node: associated.node_id, attempt: associated.attempt_id, phase: associated.phase, role: associated.role }, { node: "a", attempt: "a-attempt-1", phase: "C", role: "planning" });
    assert.deepEqual(resolveAssociation(root, {}), { associated: false, reason: "not_subagent_child" });
    assert.throws(() => resolveAssociation(root, { ...env, PI_SUBAGENT_CHILD_AGENT: "local-craft-builder" }), /does not match phase/);
  });

  test("association advances phase from persisted artifacts without prompt parsing", () => {
    const { env } = fixture(root, { agent: "local-craft-builder", phases: { C: { status: "passed" } } });
    assert.equal(resolveAssociation(root, env).phase, "R");
  });

  test("usage normalization keeps actual numeric accounting only", () => {
    assert.deepEqual(normalizeUsage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.1, total: 3.3 }, content: SECRET }), {
      input: 10, output: 5, cache_read: 2, cache_write: 1, total_tokens: 18,
      cost: { input: 1, output: 2, cache_read: 0.2, cache_write: 0.1, total: 3.3 },
    });
  });

  test("collector stores hashes and accounting but never prompt, assistant, or tool content", () => {
    const { env } = fixture(root);
    const association = resolveAssociation(root, env);
    const collector = new TelemetryCollector({ rootDir: root, association, sessionId: "session-1", sessionFile: "/private/session.jsonl", model: "openai/model", activeTools: ["read"] });
    collector.capturePrompt(SECRET, `system ${SECRET}`, ["read", "bash"]);
    collector.turnStarted();
    collector.toolStarted("call-secret", "bash", { command: SECRET });
    collector.toolEnded("call-secret", "bash", false, { output: SECRET });
    collector.captureAssistant({ role: "assistant", provider: "openai", model: "model", api: "responses", content: [{ type: "text", text: SECRET }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } }, stopReason: "stop" });
    collector.finalize();
    const stored = readTree(path.join(root, ".pi/goal-runs/default/telemetry"));
    assert.equal(stored.includes(SECRET), false);
    const manifest = JSON.parse(fs.readFileSync(collector.manifestPath, "utf8"));
    assert.equal(manifest.usage.total_tokens, 15);
    assert.equal(manifest.usage.cost.total, 0.3);
    assert.deepEqual(manifest.observed_models, ["openai/model"]);
    assert.equal(manifest.tools.calls, 1);
    assert.equal(manifest.status, "completed");
    assert.equal(fs.statSync(path.join(root, ".pi/goal-runs/default")).mode & 0o077, 0);
    assert.equal(manifest.prompt.algorithm, "hmac-sha256");
    assert.equal("bytes" in manifest.prompt, false);
    assert.notEqual(manifest.prompt.digest, hashValue("agent-pool.telemetry.prompt.v1", SECRET).digest);
    assert.equal(JSON.stringify(manifest).includes("/private/session.jsonl"), false);
  });

  test("hashes are domain separated", () => {
    assert.notEqual(hashValue("prompt", "same").digest, hashValue("system", "same").digest);
  });

  test("candidate rejects traversal references instead of reading external artifacts", () => {
    const { ledger, attempt, plan: sourcePlan } = fixture(root);
    const secretPath = path.join(root, ".pi/goal-runs/secret.json"); fs.writeFileSync(secretPath, JSON.stringify({ secret: SECRET }));
    attempt.final_status = "passed"; attempt.phases = { C: { status: "passed", path: "nested/../../secret.json", sha256: "a".repeat(64) } }; ledger.nodes.a.status = "passed";
    const result = emitEvalCandidate({ rootDir: root, runId: "default", plan: sourcePlan, ledger, nodeId: "a", attemptId: "a-attempt-1" });
    const candidate = JSON.parse(fs.readFileSync(path.join(root, result.path), "utf8"));
    assert.equal(candidate.phases.C.artifact_path, null);
    assert.ok(candidate.eligibility_reasons.includes("invalid_c_artifact_reference"));
    assert.equal(JSON.stringify(candidate).includes(SECRET), false);
    assert.equal(JSON.stringify(candidate).includes("nested/../../secret.json"), false);
  });

  test("candidate refuses a symlinked goal-runs ancestor", () => {
    const secondRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-telemetry-root-")));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-telemetry-runs-"));
    fs.mkdirSync(path.join(secondRoot, ".pi"), { recursive: true }); fs.symlinkSync(outside, path.join(secondRoot, ".pi/goal-runs"));
    fs.mkdirSync(path.join(outside, "default"), { recursive: true });
    const sourcePlan = plan();
    const ledger = { nodes: { a: { status: "passed", attempts: [{ attempt_id: "a-attempt-1", flow: "C-R-A-F-T-S", phases: {}, final_status: "passed" }] } } };
    try { assert.throws(() => emitEvalCandidate({ rootDir: secondRoot, runId: "default", plan: sourcePlan, ledger, nodeId: "a", attemptId: "a-attempt-1" }), /symlink/); }
    finally { fs.rmSync(secondRoot, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
  });

  test("candidate refuses symlinked telemetry session roots", () => {
    const { ledger, attempt, plan: sourcePlan } = fixture(root);
    attempt.final_status = "passed"; ledger.nodes.a.status = "passed";
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-outside-"));
    const telemetryRoot = path.join(root, ".pi/goal-runs/default/telemetry"); fs.mkdirSync(telemetryRoot, { recursive: true }); fs.symlinkSync(outside, path.join(telemetryRoot, "sessions"));
    try { assert.throws(() => emitEvalCandidate({ rootDir: root, runId: "default", plan: sourcePlan, ledger, nodeId: "a", attemptId: "a-attempt-1" }), /symlink/); }
    finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  test("candidate is allowlisted, telemetry-only, and explains formal ineligibility", () => {
    const { env, ledger, attempt, plan: sourcePlan } = fixture(root);
    const association = resolveAssociation(root, env);
    const collector = new TelemetryCollector({ rootDir: root, association, sessionId: "session-1", sessionFile: null, model: "openai/model" });
    collector.captureAssistant({ provider: "openai", model: "model", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } });
    collector.finalize();
    attempt.final_status = "passed";
    attempt.phases = { C: { status: "passed", path: "phases/a/a-attempt-1/C.json", sha256: "c" } };
    ledger.nodes.a.status = "passed";
    fs.writeFileSync(path.join(root, ".pi/goal-runs/default/ledger.json"), JSON.stringify(ledger));
    const result = emitEvalCandidate({ rootDir: root, runId: "default", plan: sourcePlan, ledger, nodeId: "a", attemptId: "a-attempt-1" });
    const candidate = JSON.parse(fs.readFileSync(path.join(root, result.path), "utf8"));
    assert.equal(candidate.eligibility, "telemetry-only");
    assert.equal(candidate.formal_eval_eligible, false);
    assert.deepEqual(candidate.methodology, METHODOLOGY);
    assert.ok(candidate.eligibility_reasons.includes("local_crafts_wrapped"));
    assert.ok(candidate.eligibility_reasons.includes("not_n3_replayed"));
    assert.equal(JSON.stringify(candidate).includes(SECRET), false);
    assert.equal("summary" in candidate, false);
  });
});
