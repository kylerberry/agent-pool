import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { validatePlan, validatePlanObject, hashPlanBytes } from "./goal-plan.mjs";

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function makePlan(root, overrides = {}) {
  const planPath = path.join(root, "plan.json");
  const plan = {
    schema_version: 1,
    nodes: [
      { id: "a", intent: "A", change_spec: "Do A", acceptance_criteria: ["A works"], depends_on: [] },
      { id: "b", intent: "B", change_spec: "Do B", acceptance_criteria: ["B works"], depends_on: ["a"] },
      { id: "c", intent: "C", change_spec: "Do C", acceptance_criteria: ["C works"], depends_on: ["a"] },
    ],
    approval: { approved_by: "test", approved_at: new Date(Date.now() - 60_000).toISOString() },
    ...overrides,
  };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return planPath;
}

describe("goal-plan", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-plan-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("validatePlan returns plan and stable byte hash", () => {
    const planPath = makePlan(root);
    const bytes = fs.readFileSync(planPath);
    const result = validatePlan(planPath);
    assert.equal(result.sha, sha256(bytes));
    assert.equal(result.plan.schema_version, 1);
    assert.equal(result.plan.nodes.length, 3);
  });

  test("validatePlan rejects missing file", () => {
    assert.throws(() => validatePlan(path.join(root, "missing.json")), /not found|ENOENT/);
  });

  test("validatePlanObject rejects duplicate IDs", () => {
    const planPath = makePlan(root);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.nodes.push({ id: "a", intent: "D", change_spec: "Do D", acceptance_criteria: ["D works"], depends_on: [] });
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /duplicated/);
  });

  test("validatePlanObject rejects missing dependencies", () => {
    const planPath = makePlan(root);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.nodes[0].depends_on = ["missing"];
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /invalid dependency/);
  });

  test("validatePlanObject rejects cycles", () => {
    const planPath = makePlan(root);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.nodes[0].depends_on = ["b"];
    plan.nodes[1].depends_on = ["a"];
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /cycle/);
  });

  test("validatePlanObject rejects missing approval", () => {
    const planPath = makePlan(root);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    delete plan.approval;
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /approval/);
  });

  test("validatePlanObject rejects malformed criteria", () => {
    const planPath = makePlan(root);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.nodes[0].acceptance_criteria = [""];
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /criterion/);
  });

  test("hashPlanBytes is stable", () => {
    const bytes = Buffer.from(JSON.stringify({ schema_version: 1 }));
    assert.equal(hashPlanBytes(bytes), hashPlanBytes(bytes));
    assert.match(hashPlanBytes(bytes), /^[0-9a-f]{64}$/);
  });
});
