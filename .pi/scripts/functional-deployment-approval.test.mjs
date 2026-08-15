import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  authorizeKnownCanonicalPlan,
  FUNCTIONAL_DEPLOYMENT_KIND,
  TRUSTED_ACTIVE_PLAN_SHA256,
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

function fixture(root, rootNodeId = "deployment-bootstrap-policy-and-glm52-qualification") {
  const candidate = {
    schema_version: 1,
    kind: FUNCTIONAL_DEPLOYMENT_KIND,
    source: "docs/raw/specs/functional-pool-deployment.md",
    nodes: [{ id: rootNodeId, intent: "Qualify", change_spec: "Qualify exact models", acceptance_criteria: ["Qualified"], depends_on: [] }],
  };
  const candidateSha = write(root, "docs/raw/plans/functional-pool-deployment-dag.candidate.json", candidate);
  const sourceSha = write(root, "docs/raw/specs/functional-pool-deployment.md", `candidate ${candidateSha}\n`);
  const scopeSha = write(root, "docs/raw/plans/functional-pool-deployment-dag.scope-review.json", {
    schema_version: 1,
    candidate_path: "docs/raw/plans/functional-pool-deployment-dag.candidate.json",
    candidate_sha256: candidateSha,
    nodes: { [rootNodeId]: {} },
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
  return { plan, approval, candidate };
}
const canonicalPlanBytes = (candidate, approval) => Buffer.from(`${JSON.stringify({ ...candidate, approval }, null, 2)}\n`);

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

  test("recognizes the resliced root sentinel alone and fails closed without detached approval", () => {
    const { plan } = fixture(root);
    delete plan.kind;
    delete plan.source;
    fs.rmSync(path.join(root, "docs/raw/plans/functional-pool-deployment-approval.json"));
    assert.throws(() => validateFunctionalDeploymentActivation(root, plan), /detached approval.*missing/i);
  });

  test("recognizes the candidate by kind alone or source alone with a non-sentinel root", () => {
    for (const drop of [["source"], ["kind"]]) {
      const localRoot = fs.mkdtempSync(path.join(root, "case-"));
      const { plan } = fixture(localRoot, "ordinary-non-sentinel-node");
      for (const key of drop) delete plan[key];
      fs.rmSync(path.join(localRoot, "docs/raw/plans/functional-pool-deployment-approval.json"));
      assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /detached approval.*missing/i, drop.join("+"));
    }
  });

  test("fails closed for a full candidate with all identity markers removed and only generic approval", () => {
    const localRoot = fs.mkdtempSync(path.join(root, "case-"));
    const { plan } = fixture(localRoot, "ordinary-non-sentinel-node");
    delete plan.kind;
    delete plan.source;
    plan.approval.notes = "approved";
    assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /does not equal.*candidate/i);
  });

  test("fails closed for the obsolete nine-node root sentinel alone", () => {
    const localRoot = fs.mkdtempSync(path.join(root, "case-"));
    const { plan } = fixture(localRoot, "model-policy-zai-qualification");
    delete plan.kind;
    delete plan.source;
    assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /does not equal.*candidate/i);
  });

  test("fails closed for unrelated plans with only generic approval metadata", () => {
    assert.throws(() => validateFunctionalDeploymentActivation(root, {
      schema_version: 1,
      nodes: [{ id: "other", intent: "Other", change_spec: "Other", acceptance_criteria: ["Other"], depends_on: [] }],
      approval: { approved_by: "test", approved_at: "2026-08-13T12:00:00.000Z", notes: "approved" },
    }), /detached approval is missing/i);
  });
});

describe("canonical plan activation authorization", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "functional-authorization-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("authorizes the exact completed Pool Proof canonical plan without detached approval", () => {
    const plan = JSON.parse(completedPlanBytes.toString("utf8"));
    const result = authorizeKnownCanonicalPlan(root, plan, TRUSTED_ACTIVE_PLAN_SHA256);
    assert.equal(result.authorized, true);
    assert.equal(result.basis, "trusted-active-plan");
  });

  test("rejects a completed-plan identity whose SHA does not match the trusted constant", () => {
    const plan = JSON.parse(completedPlanBytes.toString("utf8"));
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, "0".repeat(64)), /detached approval is missing/i);
  });

  test("rejects an arbitrary unknown replacement plan with generic approval", () => {
    const plan = {
      schema_version: 1,
      nodes: [{ id: "rogue-replacement", intent: "R", change_spec: "R", acceptance_criteria: ["R"], depends_on: [] }],
      approval: { approved_by: "attacker", approved_at: "2026-08-14T00:00:00.000Z", notes: "approved" },
    };
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, "1".repeat(64)), /detached approval is missing/i);
  });

  test("rejects a marker-stripped functional candidate with generic approval under authorization", () => {
    const { plan } = fixture(root, "renamed-root-node");
    delete plan.kind;
    delete plan.source;
    plan.approval.notes = "approved";
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, "2".repeat(64)), /does not equal.*candidate/i);
  });

  test("rejects an added approval notes field even when the supplied SHA matches its canonical bytes", () => {
    const { plan, candidate } = fixture(root);
    plan.approval.notes = "approved";
    const sha = sha256(Buffer.from(`${JSON.stringify({ ...candidate, approval: plan.approval }, null, 2)}\n`));
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, sha), /plan approval.*missing or unknown fields/i);
  });

  test("rejects a changed approval notes value even when the supplied SHA matches its canonical bytes", () => {
    const { plan, candidate } = fixture(root);
    plan.approval.notes = "attacker-controlled approval context";
    const sha = sha256(Buffer.from(`${JSON.stringify({ ...candidate, approval: plan.approval }, null, 2)}\n`));
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, sha), /plan approval.*missing or unknown fields/i);
  });

  test("rejects an unknown approval field even when the supplied SHA matches its canonical bytes", () => {
    const { plan, candidate } = fixture(root);
    plan.approval.signature = "attacker";
    const sha = sha256(Buffer.from(`${JSON.stringify({ ...candidate, approval: plan.approval }, null, 2)}\n`));
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, sha), /plan approval.*missing or unknown fields/i);
  });

  test("requires a valid canonical plan SHA-256", () => {
    const { plan } = fixture(root);
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, "not-a-sha"), /SHA-256 is required/i);
  });

  test("authorizes the detached-approved plan at the exact canonical bytes", () => {
    const { plan, candidate } = fixture(root);
    const sha = sha256(canonicalPlanBytes(candidate, plan.approval));
    const result = authorizeKnownCanonicalPlan(root, plan, sha);
    assert.equal(result.authorized, true);
    assert.equal(result.basis, "detached-functional-approval");
    assert.match(result.candidateSha256, /^[0-9a-f]{64}$/);
  });

  test("rejects parsed-equal plans whose active bytes are only a reserialization of the canonical bytes", () => {
    const { plan, candidate } = fixture(root);
    const approved = { ...candidate, approval: plan.approval };
    const canonicalSha = sha256(canonicalPlanBytes(candidate, plan.approval));
    const compactSha = sha256(Buffer.from(JSON.stringify(approved)));
    const tabSha = sha256(Buffer.from(`${JSON.stringify(approved, null, "\t")}\n`));
    const noTrailingNewlineSha = sha256(Buffer.from(JSON.stringify(approved, null, 2)));
    for (const sha of [compactSha, tabSha, noTrailingNewlineSha]) {
      assert.notEqual(sha, canonicalSha);
      assert.throws(() => authorizeKnownCanonicalPlan(root, plan, sha), /does not match the approved canonical plan bytes/i);
    }
  });

  test("rejects a key-reordered reserialization of the approved plan bytes", () => {
    const { plan, candidate } = fixture(root);
    const reordered = { approval: plan.approval, ...candidate };
    const reorderedSha = sha256(Buffer.from(`${JSON.stringify(reordered, null, 2)}\n`));
    assert.notEqual(reorderedSha, sha256(canonicalPlanBytes(candidate, plan.approval)));
    assert.throws(() => authorizeKnownCanonicalPlan(root, plan, reorderedSha), /does not match the approved canonical plan bytes/i);
  });
});

describe("governing artifact symlink containment", () => {
  let root;
  let external;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "functional-symlink-"));
    external = fs.mkdtempSync(path.join(os.tmpdir(), "functional-symlink-external-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });

  const GOVERNING_ARTIFACTS = [
    "docs/raw/plans/functional-pool-deployment-approval.json",
    "docs/raw/plans/functional-pool-deployment-dag.candidate.json",
    "docs/raw/specs/functional-pool-deployment.md",
    "docs/raw/plans/functional-pool-deployment-dag.scope-review.json",
    "docs/raw/plans/completed-pool-proof-build-dag.json",
  ];

  test("rejects a final-component symlink to an external file for each governing artifact", () => {
    for (const relative of GOVERNING_ARTIFACTS) {
      const localRoot = fs.mkdtempSync(path.join(root, "final-"));
      const { plan } = fixture(localRoot);
      const externalFile = path.join(external, `final-${path.basename(relative)}`);
      fs.copyFileSync(path.join(localRoot, relative), externalFile);
      fs.rmSync(path.join(localRoot, relative));
      fs.symlinkSync(externalFile, path.join(localRoot, relative));
      assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /symbolic link/i, relative);
    }
  });

  test("rejects an ancestor-directory symlink to an external directory for each governing artifact", () => {
    for (const relative of GOVERNING_ARTIFACTS) {
      const localRoot = fs.mkdtempSync(path.join(root, "ancestor-"));
      const { plan } = fixture(localRoot);
      const ancestor = path.dirname(path.join(localRoot, relative));
      const externalDir = path.join(external, `ancestor-${path.basename(relative)}`);
      fs.cpSync(ancestor, externalDir, { recursive: true });
      fs.rmSync(ancestor, { recursive: true });
      fs.symlinkSync(externalDir, ancestor);
      assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /symbolic link/i, relative);
    }
  });

  test("rejects an ancestor swapped to an external symlink between the precheck and the open", () => {
    const localRoot = fs.mkdtempSync(path.join(root, "race-ancestor-"));
    const { plan } = fixture(localRoot);
    // External tree holds byte-identical copies, so the external bytes would otherwise validate.
    const externalRoot = fs.mkdtempSync(path.join(external, "race-ancestor-"));
    fs.cpSync(path.join(localRoot, "docs"), path.join(externalRoot, "docs"), { recursive: true });
    // Swap on the last-read governing artifact so no later artifact's precheck masks the race.
    const raceTarget = "completed-pool-proof-build-dag.json";
    const originalOpen = fs.openSync;
    let swapped = false;
    fs.openSync = function raceOpen(pathArg, flags, ...rest) {
      if (!swapped && (flags & fs.constants.O_NOFOLLOW) === fs.constants.O_NOFOLLOW && String(pathArg).endsWith(raceTarget)) {
        swapped = true;
        fs.renameSync(path.join(localRoot, "docs"), path.join(localRoot, "docs.real"));
        fs.symlinkSync(path.join(externalRoot, "docs"), path.join(localRoot, "docs"));
      }
      return originalOpen.call(fs, pathArg, flags, ...rest);
    };
    try {
      assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /symbolic link|resolved outside|no longer references|is missing/i);
    } finally {
      fs.openSync = originalOpen;
    }
  });

  test("rejects a final component swapped to an external symlink between the precheck and the open", () => {
    const localRoot = fs.mkdtempSync(path.join(root, "race-final-"));
    const { plan } = fixture(localRoot);
    const originalOpen = fs.openSync;
    let swapped = false;
    fs.openSync = function raceOpen(pathArg, flags, ...rest) {
      if (!swapped && (flags & fs.constants.O_NOFOLLOW) === fs.constants.O_NOFOLLOW) {
        swapped = true;
        const externalFile = path.join(external, "race-final-approval.json");
        fs.copyFileSync(path.join(localRoot, "docs/raw/plans/functional-pool-deployment-approval.json"), externalFile);
        fs.rmSync(path.join(localRoot, "docs/raw/plans/functional-pool-deployment-approval.json"));
        fs.symlinkSync(externalFile, path.join(localRoot, "docs/raw/plans/functional-pool-deployment-approval.json"));
      }
      return originalOpen.call(fs, pathArg, flags, ...rest);
    };
    try {
      assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /symbolic link|is missing/i);
    } finally {
      fs.openSync = originalOpen;
    }
  });

  test("preserves parsed deep equality as an independent requirement for symlinked bytes", () => {
    const localRoot = fs.mkdtempSync(path.join(root, "case-"));
    const { plan } = fixture(localRoot);
    plan.nodes[0].intent = "Changed after approval";
    assert.throws(() => validateFunctionalDeploymentActivation(localRoot, plan), /does not equal.*candidate/i);
  });
});
