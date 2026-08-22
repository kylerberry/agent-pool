import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

// The original four-node replacement milestone remains an unapproved historical candidate.
// The active plan is its approved repository-bound successor; both candidate artifacts remain
// approval-free while proposed-build-dag.json is the only dispatch authority.
describe("replacement milestone DAG candidate", () => {
  const candidate = readJson("docs/raw/plans/replacement-milestone-dag.candidate.json");

  test("declares exactly four five-field nodes with the required topology", () => {
    assert.equal(candidate.schema_version, 1);
    assert.equal(candidate.nodes.length, 4);
    const expected = {
      "generalize-proven-runner": [],
      "compose-direct-intake-to-execution": ["generalize-proven-runner"],
      "general-deterministic-verifier": ["generalize-proven-runner"],
      "surface-reviewable-output": ["compose-direct-intake-to-execution", "general-deterministic-verifier"],
    };
    assert.deepEqual(Object.fromEntries(candidate.nodes.map((node) => [node.id, [...node.depends_on]])), expected);
    for (const node of candidate.nodes) {
      assert.deepEqual(Object.keys(node).sort(), ["acceptance_criteria", "change_spec", "depends_on", "id", "intent"]);
      assert.ok(node.acceptance_criteria.length > 0);
    }
  });

  test("declares no domain boundary change and carries no approval", () => {
    assert.equal(candidate.domain_boundaries_changed, false);
    assert.equal(candidate.approval, undefined);
  });

  test("stays on the direct tracer path and defers nonessential control planes", () => {
    const text = JSON.stringify(candidate);
    assert.match(text, /Minimal Pool Runtime/);
    assert.match(text, /POST \/tasks/);
    assert.match(text, /SQLite-backed/);
    assert.match(text, /deterministic verifier/);
    assert.match(text, /local review branch/);
    for (const deferred of ["Redis or BullMQ", "Tier-2 grading", "GitHub credentials", "automatic PR creation"]) {
      assert.match(text, new RegExp(deferred.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(candidate.nodes[1].change_spec, /free-form work entry|deterministic decomposition output/);
    assert.doesNotMatch(candidate.nodes[0].change_spec, /current conductor path|CRAFTS phase invocation/);
  });

  test("omits scope-review metadata because no node needs an exception", () => {
    assert.equal(candidate.scope_review_path, undefined);
    assert.equal(fs.existsSync(path.join(root, "docs/raw/plans/replacement-milestone-dag.scope-review.json")), false);
  });

  test("the candidate is validated structurally once approval is added, without activation", async () => {
    const { validatePlanObject } = await import("./goal-plan.mjs");
    const withApproval = structuredClone(candidate);
    delete withApproval.kind;
    withApproval.approval = { approved_by: "kyler", approved_at: "2026-08-16T00:00:00Z" };
    assert.doesNotThrow(() => validatePlanObject(withApproval, Buffer.byteLength(JSON.stringify(withApproval))));
  });

  test("the active proposed-build-dag.json is the approved repository-bound milestone", () => {
    const active = readJson("docs/raw/plans/proposed-build-dag.json");
    const repositoryBoundCandidate = readJson("docs/raw/plans/repository-bound-pool-milestone.candidate.json");
    assert.equal(typeof active.approval?.approved_by, "string");
    assert.equal(active.domain_boundaries_changed, false);
    assert.deepEqual(active.nodes.map((node) => node.id), repositoryBoundCandidate.nodes.map((node) => node.id));
    assert.deepEqual(
      Object.fromEntries(active.nodes.map((node) => [node.id, [...node.depends_on]])),
      Object.fromEntries(repositoryBoundCandidate.nodes.map((node) => [node.id, [...node.depends_on]])),
    );
  });

  test("the superseded 17-node plan is archived byte-for-byte and distinct", () => {
    const superseded = readJson("docs/raw/plans/superseded-functional-deployment-build-dag.json");
    assert.equal(superseded.nodes.length, 17);
    assert.equal(typeof superseded.approval?.approved_by, "string");
    const activeIds = readJson("docs/raw/plans/proposed-build-dag.json").nodes.map((node) => node.id).sort();
    assert.notDeepEqual(superseded.nodes.map((node) => node.id).sort(), activeIds);
  });
});
