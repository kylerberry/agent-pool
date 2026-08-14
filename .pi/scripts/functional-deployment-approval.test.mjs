import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  FUNCTIONAL_DEPLOYMENT_KIND,
  validateFunctionalDeploymentActivation,
} from "./functional-deployment-approval.mjs";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const completedPlanBytes = fs.readFileSync(new URL("../../docs/raw/plans/completed-pool-proof-build-dag.json", import.meta.url));
const write = (root, relative, value) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  fs.writeFileSync(target, bytes);
  return sha256(bytes);
};

function fixture(root) {
  const candidate = {
    schema_version: 1,
    kind: FUNCTIONAL_DEPLOYMENT_KIND,
    source: "docs/raw/specs/functional-pool-deployment.md",
    nodes: [{ id: "model-policy-zai-qualification", intent: "Qualify", change_spec: "Qualify exact models", acceptance_criteria: ["Qualified"], depends_on: [] }],
  };
  const candidateSha = write(root, "docs/raw/plans/functional-pool-deployment-dag.candidate.json", candidate);
  const sourceSha = write(root, "docs/raw/specs/functional-pool-deployment.md", `candidate ${candidateSha}\n`);
  const scopeSha = write(root, "docs/raw/plans/functional-pool-deployment-dag.scope-review.json", {
    schema_version: 1,
    candidate_path: "docs/raw/plans/functional-pool-deployment-dag.candidate.json",
    candidate_sha256: candidateSha,
    nodes: { "model-policy-zai-qualification": {} },
  });
  const archiveSha = write(root, "docs/raw/plans/completed-pool-proof-build-dag.json", completedPlanBytes);
  const approval = {
    schema_version: 1,
    candidate_path: "docs/raw/plans/functional-pool-deployment-dag.candidate.json",
    candidate_sha256: candidateSha,
    source_path: "docs/raw/specs/functional-pool-deployment.md",
    source_sha256: sourceSha,
    scope_review_path: "docs/raw/plans/functional-pool-deployment-dag.scope-review.json",
    scope_review_sha256: scopeSha,
    completed_plan_archive_path: "docs/raw/plans/completed-pool-proof-build-dag.json",
    completed_plan_archive_sha256: archiveSha,
    approved_by: "kyler",
    approved_at: "2026-08-13T12:00:00.000Z",
  };
  write(root, "docs/raw/plans/functional-pool-deployment-approval.json", approval);
  const plan = { ...candidate, approval: { approved_by: approval.approved_by, approved_at: approval.approved_at } };
  return { plan, approval };
}

describe("functional deployment activation approval", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "functional-approval-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("accepts only a canonical plan equal to the exact detached-approved candidate", () => {
    const { plan } = fixture(root);
    const result = validateFunctionalDeploymentActivation(root, plan);
    assert.equal(result.applicable, true);
    assert.match(result.candidateSha256, /^[0-9a-f]{64}$/);
  });

  test("rejects generic approval notes when the detached approval record is absent", () => {
    const { plan } = fixture(root);
    fs.rmSync(path.join(root, "docs/raw/plans/functional-pool-deployment-approval.json"));
    plan.approval.notes = "approved";
    assert.throws(() => validateFunctionalDeploymentActivation(root, plan), /detached approval.*missing/i);
  });

  test("rejects any changed approved artifact bytes", () => {
    const artifacts = [
      "docs/raw/plans/functional-pool-deployment-dag.candidate.json",
      "docs/raw/specs/functional-pool-deployment.md",
      "docs/raw/plans/functional-pool-deployment-dag.scope-review.json",
      "docs/raw/plans/completed-pool-proof-build-dag.json",
    ];
    for (const relative of artifacts) {
      const localRoot = fs.mkdtempSync(path.join(root, "case-"));
      const { plan } = fixture(localRoot);
      fs.appendFileSync(path.join(localRoot, relative), "\nchanged");
      assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /SHA-256 mismatch|JSON parse error/i, relative);
    }
  });

  test("rejects canonical plan drift from the approved candidate", () => {
    const { plan } = fixture(root);
    plan.nodes[0].intent = "Changed after approval";
    assert.throws(() => validateFunctionalDeploymentActivation(root, plan), /does not equal.*candidate/i);
  });

  test("rejects approval identity drift", () => {
    const { plan } = fixture(root);
    plan.approval.approved_by = "someone-else";
    assert.throws(() => validateFunctionalDeploymentActivation(root, plan), /identity.*does not match/i);
  });

  test("does not apply to unrelated active plans", () => {
    const result = validateFunctionalDeploymentActivation(root, {
      schema_version: 1,
      nodes: [{ id: "other", intent: "Other", change_spec: "Other", acceptance_criteria: ["Other"], depends_on: [] }],
      approval: { approved_by: "test", approved_at: "2026-08-13T12:00:00.000Z" },
    });
    assert.deepEqual(result, { applicable: false });
  });
});
