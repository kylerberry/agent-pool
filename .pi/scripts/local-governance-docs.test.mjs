import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// Documentation authority regression: current governing docs must not present detached
// exact-hash deployment approval or mandatory all-node sidecars as local dispatch authority,
// historical evidence must be marked as such, and obsolete executable authorization code must
// not exist.
describe("local governance documentation authority", () => {
  const activeDocs = [
    "AGENTS.md",
    ".pi/skills/goal/SKILL.md",
    ".pi/skills/craft/SKILL.md",
    "docs/goal-prompt.md",
    "docs/raw/context/local-repository-builder-workflow.md",
    "docs/raw/context/repository-builder-vs-pool-worker.md",
    "docs/wiki/index.md",
    "docs/wiki/overview.md",
    "docs/wiki/sources/2026-08-05_pool-proof-specification.md",
  ];

  test("current authority document exists and names the governing rules", () => {
    const doc = read("docs/raw/context/local-repository-builder-workflow.md");
    assert.match(doc, /structurally valid/);
    assert.match(doc, /approval/);
    assert.match(doc, /domain_boundaries_changed/);
    assert.match(doc, /scope_review_path/);
    assert.match(doc, /target/);
    assert.match(doc, /frozen_plan_sha/);
  });

  test("active documents contain no governing detached exact-hash authorization language", () => {
    const forbidden = [
      /authorizeKnownCanonicalPlan/,
      /functional-deployment-approval\.mjs/,
      /detached approval record conforming/i,
      /requires? a detached record/i,
      /review-hash-bound/i,
      /exact-hash approval required/i,
      /proposed; exact-hash/i,
      /remains exact-hash gated and unapproved/i,
    ];
    for (const relative of activeDocs) {
      const text = read(relative);
      for (const pattern of forbidden) {
        assert.doesNotMatch(text, pattern, `${relative} must not govern through ${pattern}`);
      }
    }
  });

  test("the goal skill documents conditional domain-map gating, optional sidecars, direct decisions, and explicit continuation", () => {
    const skill = read(".pi/skills/goal/SKILL.md");
    assert.match(skill, /domain_boundaries_changed/);
    assert.match(skill, /scope_review_path/);
    assert.match(skill, /"human-decision"/);
    assert.match(skill, /target/);
    assert.match(skill, /continue-ready/);
    assert.match(skill, /exactly one node per `\/goal` invocation/);
  });

  test("root AGENTS.md anchors the current local workflow authority and demotes deployment specs to historical evidence", () => {
    const agents = read("AGENTS.md");
    assert.match(agents, /docs\/raw\/context\/local-repository-builder-workflow\.md` \(current local workflow authority\)/);
    assert.match(agents, /docs\/raw\/specs\/functional-pool-deployment\.md` \(historical evidence; no longer local dispatch authority\)/);
  });

  test("the completed Pool Proof source page points to its archived canonical DAG", () => {
    const page = read("docs/wiki/sources/2026-08-05_pool-proof-specification.md");
    assert.match(page, /Completed Build Phase/);
    assert.match(page, /docs\/raw\/plans\/completed-pool-proof-build-dag\.json/);
    assert.doesNotMatch(page, /canonical DAG at `docs\/raw\/plans\/proposed-build-dag\.json`/);
  });

  test("historical exact-hash evidence carries non-authoritative banners", () => {
    const deployment = read("docs/raw/specs/functional-pool-deployment.md");
    assert.match(deployment, /Historical/i);
    assert.match(deployment, /non-authoritative/i);
    assert.match(deployment, /local-repository-builder-workflow\.md/);
    const poolProof = read("docs/raw/specs/pool-proof.md");
    assert.match(poolProof, /Historical/i);
    assert.match(poolProof, /local-repository-builder-workflow\.md/);
    // Post-activation coherence: historical specs must not still claim, in the present
    // tense, that no approval exists or that the deployment candidate remains
    // unapproved, and a completed phase's frontmatter must carry historical status.
    assert.doesNotMatch(deployment, /No detached approval record exists yet/);
    assert.doesNotMatch(deployment, /remains unapproved/);
    assert.doesNotMatch(deployment, /are proposed only/);
    assert.match(deployment, /^status: historical-evidence$/m);
    assert.match(poolProof, /^status: historical-evidence$/m);
  });

  test("obsolete executable exact-authorization modules are removed", () => {
    for (const relative of [
      ".pi/scripts/functional-deployment-approval.mjs",
      ".pi/scripts/functional-deployment-approval.test.mjs",
      ".pi/scripts/functional-deployment-reslice.test.mjs",
    ]) {
      assert.equal(fs.existsSync(path.join(root, relative)), false, `${relative} must not exist`);
    }
    for (const script of fs.readdirSync(path.join(root, ".pi", "scripts")).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))) {
      assert.doesNotMatch(read(path.join(".pi", "scripts", script)), /functional-deployment-approval/);
    }
  });

  test("the active plan is the approved replacement milestone and the superseded 17-node plan is archived", () => {
    const active = JSON.parse(read("docs/raw/plans/proposed-build-dag.json"));
    const candidate = JSON.parse(read("docs/raw/plans/replacement-milestone-dag.candidate.json"));
    assert.equal(typeof active.approval?.approved_by, "string");
    assert.equal(candidate.approval, undefined);
    assert.deepEqual(
      active.nodes.map((node) => node.id).sort(),
      candidate.nodes.map((node) => node.id).sort(),
    );
    const superseded = JSON.parse(read("docs/raw/plans/superseded-functional-deployment-build-dag.json"));
    assert.equal(superseded.nodes.length, 17);
    assert.equal(typeof superseded.approval?.approved_by, "string");
  });
});
