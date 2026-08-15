import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { validatePlanObject } from "./goal-plan.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const candidate = readJson("docs/raw/plans/functional-pool-deployment-dag.candidate.json");
const scopeReview = readJson("docs/raw/plans/functional-pool-deployment-dag.scope-review.json");

// Expected resliced topology: node order is the candidate array order; edges are depends_on sets.
export const EXPECTED_NODES = [
  { id: "deployment-bootstrap-policy-and-glm52-qualification", depends_on: [] },
  { id: "glm53-eligibility-qualification", depends_on: ["deployment-bootstrap-policy-and-glm52-qualification"] },
  { id: "parameterized-agent-pool-dogfood-runner", depends_on: ["deployment-bootstrap-policy-and-glm52-qualification"] },
  { id: "credential-strip-zai-dogfood", depends_on: ["parameterized-agent-pool-dogfood-runner"] },
  { id: "direct-task-first-service", depends_on: ["credential-strip-zai-dogfood"] },
  { id: "crafts-artifact-ledger-and-transcript-retention", depends_on: ["direct-task-first-service"] },
  { id: "full-crafts-phase-conductor", depends_on: ["crafts-artifact-ledger-and-transcript-retention"] },
  { id: "tier1-evidence-attestation", depends_on: ["full-crafts-phase-conductor"] },
  { id: "tier2-composite-verdict-audit", depends_on: ["tier1-evidence-attestation"] },
  { id: "classified-failure-retry-and-resolution", depends_on: ["tier2-composite-verdict-audit"] },
  { id: "controller-budget-guardrails", depends_on: ["classified-failure-retry-and-resolution"] },
  { id: "discovered-work-quarantine", depends_on: ["classified-failure-retry-and-resolution"] },
  { id: "queue-and-restart-recovery", depends_on: ["controller-budget-guardrails", "discovered-work-quarantine"] },
  { id: "adr015-component-pr-assembly", depends_on: ["classified-failure-retry-and-resolution"] },
  { id: "github-gate2-governed-review", depends_on: ["adr015-component-pr-assembly"] },
  { id: "single-host-operations-baseline", depends_on: ["queue-and-restart-recovery"] },
  { id: "functional-pool-release-convergence", depends_on: ["glm53-eligibility-qualification", "github-gate2-governed-review", "single-host-operations-baseline"] },
];

const OBSOLETE_NODE_IDS = [
  "model-policy-zai-qualification",
  "full-crafts-attempt-runtime",
  "grading-and-audit-verdicts",
  "controller-failure-budget-recovery",
  "adr015-github-gate2-delivery",
  "single-host-functional-pool-deployment",
];

// Distinctive substantive clauses from the superseded nine-node candidate that must survive verbatim.
const CONSERVED_CLAUSES = [
  "rejecting aliases, wildcards, case variants, and every unlisted Z.ai model",
  "GLM-5.2, Terra, and Kimi K2.7 Code compare equal",
  "GLM-5.3, Sol, and Kimi K3 compare equal",
  "evaluator selection remains a different model and never a lower tier",
  "may run only as bounded, recorded fallbacks after an eligible non-Moonshot primary fails within the same attempt",
  "Terra→Kimi K3 for node conductor and planning",
  "bounded tool execution, structured result, provider-reported usage/cost where available, same-attempt cleanup, and independent report verification",
  "availability/fallback evidence rather than an assumed account cap",
  "immutable, provider-qualified, credential-free, marked bootstrap rather than empirical",
  "byte-preserved acceptance criteria, allowed changed paths, deterministic verification commands, expected one-commit shape, exact qualified model, bounded budgets, and candidate report path",
  "traversal, symlink escape, mutable refs, arbitrary environment values, credentials, unknown fields, and unbounded input before paid model work",
  "rejects fake queue, launcher, Pi, sandbox, verifier, persistence, or provenance collaborators",
  "base-red evidence, one real Worker attempt, independent post-commit verification, exact allowed paths, clean tree, resource cleanup, and bounded reporting without repository-specific runner code",
  "manifest hash, runner version, base/result commits, exact routing evidence, verifier checks, diagnostic usage/cost, and cleanup outcome without raw prompts, credentials, transcripts, mutable paths, or provider errors",
  "explicit publication is separately authorized and no path can overwrite the sealed Pool Proof reports",
  "expected parent/one-commit shape",
  "credential canary in provider model configuration is copied into the private models.json",
  "Moonshot is used only after an explicitly induced and recorded eligible fallback condition, never as the ordinary primary",
  "excludes apiKey and equivalent credential-bearing fields, and keeps authentication solely in the separate launcher-owned private auth store",
  "identity binding, commit parent and shape, allowed paths, clean tree, tests, canary absence, resource isolation, and cleanup before recording pass; Worker prose cannot override failure",
  "bounded, hash-verifiable, credential-free, published only explicitly",
  "preserves acceptance criteria byte-for-byte, validates exact fields/IDs/dependencies/cycles/aggregate limits, and returns stable caller-scoped idempotent identities",
  "structurally unable to invoke decomposition or Gate 1 and fixes gate2_required=true with no caller-reachable override",
  "authenticated principal rather than request data",
  "malformed, inherited, cyclic, oversized, conflicting replay, and unauthorized input fails before persistence or model work",
  "ready-frontier selection is deterministic, attempt/job IDs are stable, and queue envelopes contain only bounded identifiers",
  "one immutable topology-free attempt contract with stable criterion IDs and canonical qualified routing before launching a fresh Worker",
  "bounded work/node/attempt state and correlated identities without credentials, raw provider errors, transcripts, lease capabilities, or mutable persistence internals",
  "submits a real direct fixture task and observes independently verified terminal execution through the public pool boundary",
  "schema-valid artifact covering every criterion without forwarding working transcripts",
  "append monotonic revisions rather than overwrite history",
  "records audit_incomplete on failure",
  "distinct non-lower builder/evaluator models",
  "unenforceable pairing blocks before paid phase work",
  "bounded attempts, reasons, discoveries, and dead ends",
  "C, A, and T cannot write; R/F hold implementation capability; S writes only an owner-approved knowledge sink or returns a structured proposal when none exists",
  "security-trigger routing, S confinement, restart-safe artifact history, and fail-closed invalid artifacts",
  "binds pre/post commits, suite path/hash, command, exit code, pinned environment/image, and bounded raw-output artifact",
  "hashes are recomputed before acceptance",
  "Required tests, lint, typecheck, static/security checks, clean commit shape, allowed paths, and every original criterion are deterministically attested",
  "records the actual independent evaluator invocation and routing evidence",
  "binary criteria-fit hard gate and anchored maintainability rubric",
  "cannot infer evaluator identity from builder dispatch or agent-authored claims",
  "complete criteria fit, no blocking maintainability finding, valid model independence, and complete criterion evidence",
  "append-only and queryable by work/node/attempt/criterion",
  "Identical replay is an audited no-op",
  "conflicting artifacts, costs, verdicts, identities, or terminal outcomes fail without overwrite",
  "separate monotonic counters under the fixed ceiling and downward-only overrides",
  "retries receive bounded prior failure context",
  "freeze only dependent branches while unrelated ready nodes continue",
  "retry, manual fix, cancel branch, force-pass with reason, and human-approved amend-DAG",
  "every attempted backend cost is retained with valid currency semantics",
  "Moonshot cannot become primary through fallback handling",
  "token digests, CAS versions, and unique attempt/result identities reject stale, duplicate, or conflicting actors and terminal results",
  "commit/enqueue/lease/result interruption window",
  "duplicate paid work or inferring success",
  "classified as adjacent backlog, correctness/security blocker, or amendment recommendation without mutating active scope or topology",
  "one delivery branch/PR per component",
  "one ordered commit linked to intent, criteria, Tier-1/Tier-2 evidence, composite verdict, cost, selected-model rationale, and node/attempt identities",
  "recomputes suite hashes and reruns required checks against the composed component head before PR creation/update",
  "missing/red evidence, unresolved integration failure, unexpected commits, dirty state, or component mismatch",
  "no caller, Worker, comment, small-diff exception, or automation can force completion without the authorized review record",
  "least-privilege trusted delivery adapter and never enter Worker, sandbox, repository-command, phase-artifact, log, transcript, or report environments",
  "repository/ref/identity-bound, idempotent, signature-verified where applicable, and replay-protected",
  "bounded revision inputs rather than executable instructions",
  "records PR size, branch drift, integration retries",
  "pinned identities, health/readiness checks, restart policy, and no Worker access to the host Docker socket",
  "only required Z.ai, queue, GitHub, encryption, and backup credentials",
  "only required Z.ai, queue, encryption, and backup credentials",
  "queue age/stalls, ready capacity, disk, provider failures, accumulated cost, backup freshness, cleanup failure, and migration status",
  "encrypted, WAL-safe, off-host backups under bounded retention",
  "documented empty-host restore drill verifies audit integrity before dispatch resumes",
  "API, controller, queue, Worker, sandbox, and result windows reconcile durable state, fence stale actors, remove owned resources, and neither lose nor duplicate terminal outcomes",
  "qualified Z.ai primary unless a deliberate fallback is recorded, completes full CRAFTS and composite grading, creates the ADR-015 PR, pauses for human Gate 2, and records final GitHub disposition",
  "traverse every immutable link in that run through stable IDs and hashes",
  "deterministic, Docker, retained-report, backup/restore, and owned-resource cleanup checks pass without changing Pool Proof or dogfood evidence",
  "free-form specs/Gate 1, Graphify scheduling, eval calibration, agent-assisted probes, ADR-037/038, arbitrary provider/extensions, multi-host/multi-tenant operation, formal SLO/on-call, and automatic target deployment",
];

const nodeText = (nodes) => nodes.map((node) => JSON.stringify(node)).join("\n");

describe("functional deployment resliced candidate", () => {
  test("contains exactly the 17 expected ADR-018 nodes in order with exact topology", () => {
    assert.equal(candidate.nodes.length, EXPECTED_NODES.length);
    const actual = candidate.nodes.map((node) => ({ id: node.id, depends_on: node.depends_on }));
    assert.deepEqual(actual, EXPECTED_NODES);
  });

  test("every node has exactly the five ADR-018 fields with unique IDs, unique resolved dependencies, and one root", () => {
    const ids = new Set();
    for (const node of candidate.nodes) {
      assert.deepEqual(Object.keys(node).sort(), ["acceptance_criteria", "change_spec", "depends_on", "id", "intent"], node.id);
      assert.ok(!ids.has(node.id), `duplicate node ID ${node.id}`);
      ids.add(node.id);
      assert.deepEqual(new Set(node.depends_on).size, node.depends_on.length, `duplicate dependency in ${node.id}`);
      assert.ok(!node.depends_on.includes(node.id), `self dependency in ${node.id}`);
      for (const dep of node.depends_on) assert.ok(ids.has(dep) || candidate.nodes.some((n) => n.id === dep), `dangling dependency ${dep} in ${node.id}`);
      assert.ok(node.intent && node.change_spec && node.acceptance_criteria.length > 0, node.id);
    }
    const roots = candidate.nodes.filter((node) => node.depends_on.length === 0);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, "deployment-bootstrap-policy-and-glm52-qualification");
  });

  test("Kahn topological traversal visits all 17 nodes", () => {
    const pending = new Map(candidate.nodes.map((node) => [node.id, new Set(node.depends_on)]));
    const visited = [];
    while (pending.size) {
      const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
      assert.ok(ready.length > 0, "topology contains a cycle");
      for (const id of ready) {
        pending.delete(id);
        visited.push(id);
        for (const deps of pending.values()) deps.delete(id);
      }
    }
    assert.equal(visited.length, 17);
  });

  test("rejects malformed candidate copies: sixth field, duplicate ID, dangling/duplicate/self dependency, cycle, zero roots", () => {
    const approval = { approved_by: "kyler", approved_at: "2026-08-13T12:00:00.000Z" };
    const mutations = {
      "sixth node field": (nodes) => { nodes[0].scope_metadata = { outcome: "x" }; },
      "duplicate node ID": (nodes) => { nodes[1].id = nodes[0].id; },
      "dangling dependency": (nodes) => { nodes[3].depends_on = ["does-not-exist"]; },
      "duplicate dependency": (nodes) => { nodes[2].depends_on = [nodes[2].depends_on[0], nodes[2].depends_on[0]]; },
      "self dependency": (nodes) => { nodes[2].depends_on = [nodes[2].id]; },
      "cycle": (nodes) => { nodes[0].depends_on = [nodes[16].id]; },
      "zero roots": (nodes) => { for (const node of nodes) node.depends_on = ["deployment-bootstrap-policy-and-glm52-qualification"]; },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
      const plan = JSON.parse(JSON.stringify(candidate));
      mutate(plan.nodes);
      assert.throws(() => validatePlanObject({ ...plan, approval }, JSON.stringify(plan).length), undefined, label);
    }
  });

  test("scope review is bound to the exact candidate bytes and keyed by the same 17 node IDs with complete ADR-035 records", () => {
    const bytes = fs.readFileSync(path.join(root, "docs/raw/plans/functional-pool-deployment-dag.candidate.json"));
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    assert.equal(scopeReview.schema_version, 1);
    assert.equal(scopeReview.candidate_path, "docs/raw/plans/functional-pool-deployment-dag.candidate.json");
    assert.equal(scopeReview.candidate_sha256, sha);
    const candidateIds = candidate.nodes.map((node) => node.id).sort();
    assert.deepEqual(Object.keys(scopeReview.nodes).sort(), candidateIds);
    for (const [id, record] of Object.entries(scopeReview.nodes)) {
      assert.deepEqual(Object.keys(record).sort(), ["acceptance_oracle", "blast_radius", "exceptions", "non_goals", "observable_outcome", "primary_invariant", "production_seam"], id);
      assert.deepEqual(Object.keys(record.exceptions).sort(), ["cross_domain", "multi_contract", "multi_suite"], id);
      assert.ok(record.observable_outcome && record.primary_invariant && record.acceptance_oracle && record.production_seam && record.blast_radius, id);
      assert.ok(Array.isArray(record.non_goals) && record.non_goals.length > 0, id);
    }
  });

  test("conserves every substantive clause from the superseded nine-node candidate and drops obsolete node IDs", () => {
    const text = nodeText(candidate.nodes);
    for (const clause of CONSERVED_CLAUSES) assert.ok(text.includes(clause), `missing conserved clause: ${clause}`);
    for (const id of OBSOLETE_NODE_IDS) assert.ok(!text.includes(id), `obsolete node ID survived: ${id}`);
  });

  test("node 16 stays delivery-free and node 17 owns trusted GitHub delivery-host composition", () => {
    const node16 = candidate.nodes.find((node) => node.id === "single-host-operations-baseline");
    const node17 = candidate.nodes.find((node) => node.id === "functional-pool-release-convergence");
    assert.deepEqual(node16.depends_on, ["queue-and-restart-recovery"], "node 16 must depend only on queue-and-restart-recovery");
    const text16 = JSON.stringify(node16);
    assert.ok(!/github/i.test(text16), "node 16 must not contain any GitHub/trusted-delivery requirement");
    assert.ok(!/trusted adapter/i.test(text16), "node 16 must not require trusted-adapter startup");
    assert.ok(node17.depends_on.includes("github-gate2-governed-review") && node17.depends_on.includes("single-host-operations-baseline"), "node 17 must depend on both Gate-2 review and operations");
    const text17 = JSON.stringify(node17);
    assert.match(text17, /trusted host-side GitHub adapter/, "node 17 must require trusted host-side GitHub adapter composition");
    assert.match(text17, /least-privilege trusted delivery adapter/, "node 17 must confine GitHub credentials to the least-privilege trusted delivery adapter");
    assert.match(text17, /credential-canary/, "node 17 must require credential canaries");
    const scope16Record = scopeReview.nodes["single-host-operations-baseline"];
    const scope16Requirements = JSON.stringify({
      observable_outcome: scope16Record.observable_outcome,
      primary_invariant: scope16Record.primary_invariant,
      acceptance_oracle: scope16Record.acceptance_oracle,
      production_seam: scope16Record.production_seam,
      blast_radius: scope16Record.blast_radius,
    });
    assert.ok(!/github/i.test(scope16Requirements), "node 16 scope metadata must not contain GitHub requirements");
    assert.ok(scope16Record.non_goals.some((goal) => /GitHub/i.test(goal)), "node 16 scope metadata must explicitly exclude GitHub delivery requirements");
    const scope17 = JSON.stringify(scopeReview.nodes["functional-pool-release-convergence"]);
    assert.match(scope17, /GitHub adapter/, "node 17 scope metadata must own GitHub adapter composition");
    assert.match(scope17, /credential[- ]canary/i, "node 17 scope metadata must own credential canaries");
  });

  test("remains unapproved: no detached approval record exists and the active canonical plan is untouched by this candidate", () => {
    assert.equal(fs.existsSync(path.join(root, "docs/raw/plans/functional-pool-deployment-approval.json")), false);
    const active = readJson("docs/raw/plans/proposed-build-dag.json");
    assert.notEqual(active.kind, candidate.kind);
  });
});
