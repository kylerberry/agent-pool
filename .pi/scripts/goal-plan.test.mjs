import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { validatePlan, validatePlanObject, hashPlanBytes } from "./goal-plan.mjs";

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function makePlan(root, overrides = {}, extraTop = {}) {
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
    ...extraTop,
  };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return planPath;
}

function writeDomainMap(root, { approvedBy = "kyler", approvedAt = "2026-08-15T00:00:00Z" } = {}) {
  const mapPath = path.join(root, "docs", "raw", "context", "initial-domain-map.md");
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, "# domain map\n");
  const approval = {
    map_path: "docs/raw/context/initial-domain-map.md",
    map_sha256: sha256(fs.readFileSync(mapPath)),
    approved_by: approvedBy,
    approved_at: approvedAt,
  };
  const approvalPath = path.join(root, "docs", "raw", "plans", "domain-map-approval.json");
  fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
  fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2));
  return { mapPath, approvalPath, approval };
}

describe("goal-plan", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-plan-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("validatePlan returns plan and stable byte hash", () => {
    const planPath = makePlan(root);
    const raw = fs.readFileSync(planPath);
    const result = validatePlan(root, planPath);
    assert.equal(result.sha, sha256(raw));
    assert.equal(result.plan.schema_version, 1);
    assert.equal(result.plan.nodes.length, 3);
  });

  test("validatePlan rejects missing file", () => {
    assert.throws(() => validatePlan(root, path.join(root, "missing.json")), /not found|missing/);
  });

  test("validatePlan rejects a symlinked plan file", () => {
    const planPath = makePlan(root);
    const alias = path.join(root, "alias.json");
    fs.symlinkSync(planPath, alias);
    assert.throws(() => validatePlan(root, alias), /symbolic link/);
  });

  test("validatePlan rejects a plan outside the repository root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goal-plan-outside-"));
    try {
      const planPath = makePlan(outside);
      assert.throws(() => validatePlan(root, planPath), /escapes repository root/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  test("validatePlanObject rejects duplicate IDs", () => {
    makePlan(root);
    const plan = JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8"));
    plan.nodes.push({ id: "a", intent: "D", change_spec: "Do D", acceptance_criteria: ["D works"], depends_on: [] });
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /duplicated/);
  });

  test("validatePlanObject rejects missing dependencies", () => {
    makePlan(root);
    const plan = JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8"));
    plan.nodes[0].depends_on = ["missing"];
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /invalid dependency/);
  });

  test("validatePlanObject rejects cycles", () => {
    makePlan(root);
    const plan = JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8"));
    plan.nodes[0].depends_on = ["b"];
    plan.nodes[1].depends_on = ["a"];
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /cycle/);
  });

  test("validatePlanObject rejects missing approval", () => {
    makePlan(root);
    const plan = JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8"));
    delete plan.approval;
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /approval/);
  });

  test("validatePlanObject rejects malformed criteria", () => {
    makePlan(root);
    const plan = JSON.parse(fs.readFileSync(path.join(root, "plan.json"), "utf8"));
    plan.nodes[0].acceptance_criteria = [""];
    assert.throws(() => validatePlanObject(plan, Buffer.byteLength(JSON.stringify(plan))), /criterion/);
  });

  test("hashPlanBytes is stable", () => {
    const raw = Buffer.from(JSON.stringify({ schema_version: 1 }));
    assert.equal(hashPlanBytes(raw), hashPlanBytes(raw));
    assert.match(hashPlanBytes(raw), /^[0-9a-f]{64}$/);
  });

  describe("domain_boundaries_changed signal", () => {
    test("legacy plans without the signal validate without any domain-map files", () => {
      const planPath = makePlan(root);
      assert.doesNotThrow(() => validatePlan(root, planPath));
    });

    test("an explicit false signal skips all domain-map validation", () => {
      const planPath = makePlan(root, {}, { domain_boundaries_changed: false });
      assert.equal(fs.existsSync(path.join(root, "docs", "raw", "plans", "domain-map-approval.json")), false);
      const result = validatePlan(root, planPath);
      assert.equal(result.plan.domain_boundaries_changed, false);
    });

    test("a non-boolean signal fails closed", () => {
      for (const bad of ["false", 0, null, "yes"]) {
        const planPath = makePlan(root, {}, { domain_boundaries_changed: bad });
        assert.throws(() => validatePlan(root, planPath), /domain_boundaries_changed/, String(bad));
      }
    });

    test("a true signal requires a verified domain-map approval record with a matching map SHA", () => {
      writeDomainMap(root);
      const planPath = makePlan(root, {}, { domain_boundaries_changed: true });
      assert.equal(validatePlan(root, planPath).plan.domain_boundaries_changed, true);
    });

    test("a true signal fails when the approval record is missing", () => {
      const planPath = makePlan(root, {}, { domain_boundaries_changed: true });
      assert.throws(() => validatePlan(root, planPath), /missing/);
    });

    test("a true signal fails when the map hash no longer matches the approval record", () => {
      const { mapPath } = writeDomainMap(root);
      fs.writeFileSync(mapPath, "# domain map\nmutated\n");
      const planPath = makePlan(root, {}, { domain_boundaries_changed: true });
      assert.throws(() => validatePlan(root, planPath), /SHA-256 mismatch|does not match/);
    });

    test("a true signal fails on a malformed approval record", () => {
      writeDomainMap(root);
      const approvalPath = path.join(root, "docs", "raw", "plans", "domain-map-approval.json");
      const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
      delete approval.approved_by;
      fs.writeFileSync(approvalPath, JSON.stringify(approval));
      const planPath = makePlan(root, {}, { domain_boundaries_changed: true });
      assert.throws(() => validatePlan(root, planPath), /domain-map approval/);
    });

    test("a true signal rejects a symlinked domain map", () => {
      const { mapPath } = writeDomainMap(root);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "domain-map-outside-"));
      try {
        fs.writeFileSync(path.join(outside, "evil-map.md"), "# evil\n");
        fs.rmSync(mapPath);
        fs.symlinkSync(path.join(outside, "evil-map.md"), mapPath);
        const planPath = makePlan(root, {}, { domain_boundaries_changed: true });
        assert.throws(() => validatePlan(root, planPath), /symbolic link/);
      } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    });
  });

  describe("optional ADR-035 scope-review sidecar", () => {
    function writeSidecar(rootDir, nodes) {
      const sidecarPath = path.join(rootDir, "scope-review.json");
      fs.writeFileSync(sidecarPath, JSON.stringify({ schema_version: 1, nodes }, null, 2));
      return sidecarPath;
    }

    test("ordinary plans need no sidecar at all", () => {
      const planPath = makePlan(root);
      assert.doesNotThrow(() => validatePlan(root, planPath));
    });

    test("a sidecar with exceptional node IDs and rationale validates", () => {
      writeSidecar(root, { b: { rationale: "cross-domain change is inseparable for one outcome" } });
      const planPath = makePlan(root, {}, { scope_review_path: "scope-review.json" });
      assert.equal(validatePlan(root, planPath).plan.scope_review_path, "scope-review.json");
    });

    test("a missing referenced sidecar fails", () => {
      const planPath = makePlan(root, {}, { scope_review_path: "scope-review.json" });
      assert.throws(() => validatePlan(root, planPath), /missing/);
    });

    test("sidecar node IDs must be a subset of plan node IDs", () => {
      writeSidecar(root, { "not-a-node": { rationale: "x" } });
      const planPath = makePlan(root, {}, { scope_review_path: "scope-review.json" });
      assert.throws(() => validatePlan(root, planPath), /unknown node|must reference/);
    });

    test("sidecar records require a concise non-empty rationale", () => {
      writeSidecar(root, { b: { rationale: "" } });
      const planPath = makePlan(root, {}, { scope_review_path: "scope-review.json" });
      assert.throws(() => validatePlan(root, planPath), /rationale/);
    });

    test("a symlinked sidecar is rejected", () => {
      const realSidecar = path.join(root, "real-scope.json");
      fs.writeFileSync(realSidecar, JSON.stringify({ schema_version: 1, nodes: {} }));
      fs.symlinkSync(realSidecar, path.join(root, "scope-review.json"));
      const planPath = makePlan(root, {}, { scope_review_path: "scope-review.json" });
      assert.throws(() => validatePlan(root, planPath), /symbolic link/);
    });
  });
});
