# Supervisor Orchestrator — Consolidated Specification

**Version:** 0.1-draft
**Author:** Kyler Berry
**Status:** Design complete (34 ADRs, including production-harness readiness decisions); pre-implementation
**Canonical scope:** This document is the current specification for both the supervisor and its warm-pool execution substrate. Earlier pool drafts are historical only.

---

## 1. Purpose

A self-hosted system that takes a free-form feature spec, decomposes it into a DAG of verifiable work units, executes those units in parallel on a warm pool of coding agents, grades every unit through deterministic and model-judged gates, and delivers reviewable pull requests behind a human approval gate — with a full audit trail, enforced cost/retry ceilings, and eval-backed model routing.

Design goals, in priority order:
1. **Trust** — a human only ever reviews work that already passed the machine; every model decision is logged, bounded, and attributable.
2. **Pragmatism** — runs on ~$10/month self-hosted infra; dual-use (personal daily driver and portfolio artifact); no framework dependencies that fight the design.
3. **Data-backed routing** — model selection per role is derived from a self-built eval harness, not vendor claims or vibes.

## 2. System Overview

```
free-form spec (markdown)  -- POST /specs (API; webhook/cron/CLI/agent)
      |
      v
[ Decomposer ]  -- model call; codebase-aware (graph) --> flat DAG (nodes + depends_on edges)
      |
      v
[ Schema validation ]  -- mechanical: ids, cycles, referential integrity
      |
      v
[ HUMAN GATE 1: DAG approval ]  -- persisted; re-runs resume from approved DAG
      |
      v
[ Deterministic Controller ]  -- plain TypeScript; owns all control flow
      |         dispatches ready frontier, one job per node
      v
[ Warm Agent Pool ]  -- BullMQ/Redis; DAG-unaware stateless workers
      |         each node runs CRAFTS internally (craft-pool skill)
      v
[ Grading ]  -- tier 1 (deterministic) + tier 2 (model-judged) -> composite
      |
      v
[ Re-verification at integration ]  -- tier 1 re-runs against final merged suite
      |
      v
[ PR Assembly ]  -- one PR per DAG connected component; one commit per node
      |
      v
[ HUMAN GATE 2: PR review ]  -- approve / comment (comment -> governed revision loop)
```

Two humans gates bracket the pipeline; everything between them is machine-gated and audit-logged.

## 3. Architecture Layers

### 3.1 Deterministic Controller (ADR-001)

The orchestrator is **plain code, not an agent**. Control flow — DAG state, ready-frontier computation, dispatch, retry ceilings, budget enforcement, escalation triggers, PR assembly — lives in TypeScript. Models are invoked only at named checkpoints:

| Checkpoint | Purpose |
|---|---|
| Decomposition | free-form spec → structured DAG |
| Intra-node CRAFTS phases | planning, building, assessing, tightening, sharpening (inside the pool worker) |
| Failure diagnosis (optional) | advise retry strategy inside the deterministic retry envelope |

Rationale: replayability, auditability, and structural (not prompt-based) guardrails. An agentic orchestrator's non-reproducible control flow is disqualifying for an audit-driven system. New control paths require code changes — accepted cost.

**LangGraph and orchestration frameworks were considered and rejected**: the accepted ADR set would fight a framework's assumptions rather than express through them; the frameworks' value (shared team vocabulary, effort-saving on common patterns) doesn't apply to a solo, bespoke, trust-first build.

### 3.2 Spec Boundary (ADR-002, ADR-003)

**Fuzzy in, structured out.** No prescribed spec format — the decomposition model absorbs arbitrary markdown and emits a validated DAG schema. The controller only ever consumes the normalized DAG.

Decomposition is the pipeline's one non-deterministic step (model call + retrieval index state). It is quarantined: output persisted, human-approved before dispatch (Gate 1), re-runs resume from the approved DAG — never from a fresh decomposition.

### 3.3 Execution Substrate

The warm pool is the DAG-unaware execution layer of this greenfield system:

- **Workers are DAG-unaware** (ADR-010). A job = one node's payload; workers never see structure.
- **Worker output contract is commit-and-report only.** A worker finishes a node by committing in its isolated workspace and reporting the commit plus tier-1 evidence, tier-2 result, cost, models, and suite path/hash. A trusted host-side delivery adapter pushes branches and performs GitHub API effects; repository commands never receive delivery credentials (ADR-032). Workers do not open PRs, issues, or comments.
- **No agent model override.** The original spec allowed the agent to deviate from the requested model by its own judgment. Removed: the model is pinned by the orchestrator's routing table per role; inability to honor it (including builder/evaluator diversity, §5.3) fails closed and escalates.
- **Merge arbitration is defined here, not inherited.** The original pool assumed a human decomposer guaranteeing non-conflicting units. The orchestrator replaces that human guarantee with test-suite arbitration (§7): CI/tests as merge-time arbiter, first-to-integrate wins, second re-derives against the new head.
- **v1 substrate baseline:** Hetzner-class single host, Docker Compose, Fastify + BullMQ dispatcher, Redis (AOF) for queue + session records, workspace-per-attempt cleanup, backend fallback with workspace-as-checkpoint handoff, and compressed session summaries for continuations.
- **Practical delivery safety (ADR-031):** stable attempt IDs, deterministic job IDs, unique result acceptance, versioned compare-and-set transitions, leases/heartbeats, and startup reconciliation are required in v1. Transactional outbox/inbox and stronger distributed fencing are fast-follow hardening.
- **Practical worker isolation (ADR-032):** each attempt receives an ephemeral non-root, resource-limited workspace; repository commands receive no GitHub or unrelated provider secrets; trusted host-side delivery performs GitHub effects. Stronger sandbox and egress controls are fast-follow hardening.

**Ownership split:** the pool owns *intra-attempt* resilience (backend fallback chain, max 3 backends per attempt). The orchestrator owns *cross-attempt* policy (retry ceiling, budget, escalation). One node attempt may burn through the fallback chain internally; that is still one attempt against the ceiling.

**State mapping** (queue job ↔ DAG node):

| BullMQ job state | DAG node state |
|---|---|
| PENDING / CLAIMED / RUNNING | `in_progress` |
| FALLBACK | `in_progress` (attempt continuing on next backend) |
| DONE + composite pass | `passed` (provisional until §7 re-verification) |
| DONE + composite fail, or FAILED/DEAD | `failed` → retry or `escalated` |

### 3.4 Spec Intake (ADR-027)

Intake is an **HTTP API, not a form** — submission is a machine interface; the human touchpoint is Gate 1 approval. `POST /specs` takes raw markdown plus target repo/branch and an optional `Idempotency-Key`, returns `202 {spec_id, status: "decomposing"}`, and enqueues a decomposition job. Decomposition can't complete in-request (model call + retrieval), so intake is necessarily async.

```
POST /specs                -> 202 {spec_id, status: "decomposing"}
  -> decomposition job     (model call + code-graph retrieval)
  -> schema validation     (ids, cycles, referential integrity)
  -> DAG persisted         status: "awaiting_approval"     <- GATE 1
POST /specs/{id}/approve   -> controller begins the dispatch loop
```

`GET /specs/{id}` returns status + DAG for review; `POST /specs/{id}/amend` is the ADR-024 path. CLI and any dashboard are clients of these endpoints, not separate surfaces. Auth reuses the pool's bearer token.

- **Decomposition rides a separate orchestrator queue** (same Redis, distinct contract): a node-queue job is exactly one DAG node consumed by a DAG-unaware worker (ADR-010); decomposition is neither.
- **Idempotency is client-supplied**: the key is stored on the spec record; replays return the original `spec_id` rather than decomposing twice.

Consequence: the system is driveable by anything that can POST — webhook, cron, another agent, a shell alias — rather than being implicitly human-initiated.

**Direct task path (ADR-028).** `POST /tasks` submits one unit (`change_spec`, `acceptance_criteria`, repo/branch) straight to the node queue, skipping decomposition and Gate 1; an array variant accepts hand-authored units with `depends_on` edges (mechanical validation still runs; Gate 1 optional). Downstream is unchanged — CRAFTS, tier-1/tier-2 grading, audit, PR assembly, and **Gate 2 remains mandatory**. Skipping Gate 1 is principled: that gate quarantines decomposition's non-determinism (ADR-003), and there is no decomposition to quarantine. This keeps cost proportionate to work — one-line fixes don't pay feature-sized ceremony — which is what the dual-use daily-driver goal requires.

## 4. The DAG

### 4.1 Decomposition Emission (ADR-018)

A **flat list of nodes** with edge arrays — not a tree (convergence: a node may have multiple parents).

Per-node fields emitted: `id`, `intent`, `change_spec`, `acceptance_criteria`, `depends_on`.

Explicitly **not** emitted: runtime state (`status`, `retry_count`, `budget_spent`, suite `path`/`hash` — controller-owned), `required_role` (meaningless when every node runs full CRAFTS internally; swarm-build property), `complexity` (owned by C, the phase that reasons about implementation; feeds both C's full-vs-lite routing and the model router).

Validation before Gate 1: duplicate ids, self/missing dependencies, cycle detection (topological sort).

### 4.2 Node Lifecycle

```
pending -> ready -> in_progress -> passed        (provisional)
                        |-> failed -> ready      (retry, under ceiling)
                        |          -> escalated  (ceiling hit; human required)
pending/ready -> blocked                          (upstream node escalated/cancelled/blocked)
escalated -> [human action] -> passed | cancelled
passed -> failed                                  (integration re-verification only)
```

- `failed` = one attempt's outcome. `escalated` = waiting on a human. `blocked` = healthy node stalled by its branch's upstream failure (ADR-011) — kept distinct so triage can tell "waiting on a decision" from "still running."
- `cancelled` is terminal. `passed` is provisional until connected-component integration re-verification succeeds and the component is sealed for PR assembly. Before sealing, an integration failure may reopen `passed -> failed`; the controller blocks affected descendants, re-verifies them after repair, and records versioned CAS transitions. Human abandonment folds into `cancelled`; override/force-pass is a flag on `passed`, always with a logged reason. Explicit `attempt_passed`/`integrating`/`verified` node states remain roadmap hardening.

### 4.3 Dispatch (ADR-010)

Each round the controller enqueues one self-contained job per node in the **ready frontier** (all dependencies `passed`). Pool concurrency limits throttle actual parallelism. Results update node state; the frontier is recomputed; repeat until the DAG is terminal.

### 4.4 Failure Containment (ADR-011, ADR-012, ADR-013, ADR-023)

- A failed node freezes (blocks) its dependent subtree; unrelated branches continue. No whole-DAG cancellation on single failure.
- **Retry ceilings, per failure class (ADR-023):** attempt failures are classified `logic` (the node's own defect) or `integration` (a previously-green node re-failed at re-verification because a sibling changed the head/suite). Each class has its own fixed ceiling (default 3; overrides downward only). A node is never escalated as defective for losing integration races — the escalation record names the class, since the two imply different human resolutions. Repeated integration escalations across a DAG signal decomposition contention (feeds amend-DAG, §4.5).
- **Budget:** two independent ceilings. Per-node overrun = treated as retry-ceiling failure (stop, escalate). Per-DAG aggregate overrun = halt new dispatch, let in-flight finish, escalate the whole DAG (systemic signal: bad decomposition or thrashing). **Accepted, bounded overage:** in-flight nodes run to completion past the aggregate cap; worst case = concurrency limit × max per-node budget (per-node caps still bind individually), a small known number at pool scale (3 workers). Graceful mid-node abort machinery is deliberately deferred (§13).

### 4.5 Escalation & Resolution (ADR-016, ADR-024)

Escalations surface as audit-trail queries (CLI / minimal dashboard) — no push-notification infrastructure in v1. Five fixed, logged resolution actions: **retry** (optional edit; counter resets), **manual fix**, **cancel branch**, **override/force-pass** (logged reason mandatory; flagged distinctly as a machine-gate bypass), and **amend-DAG** (ADR-024) — partial re-decomposition when implementation reveals a planned boundary is impossible: cancel the affected subtree, re-decompose only the unmet remainder (decomposer receives the original spec slice + already-passed nodes as context), validate mechanically, and re-approve through Gate 1. Passed work is never discarded. The quarantine principle restated precisely: the DAG never changes *silently* — every topology change is proposed, validated, human-approved, and logged. The code graph (§10) makes bad boundaries rare; amend-DAG is the exit when one fires anyway.

## 5. Intra-Node Execution — CRAFTS (craft-pool skill)

A node's job launches a **fresh Pi agent session** with the project `craft-pool` skill, `pi-subagents`, the original unit payload, and the permitted model/tool configuration. That session is the conductor; a separate persisted conductor agent definition is optional. It spawns every phase—including C—as a sequential Pi subagent and owns each phase's payload. C is a planning subagent, peer to the rest; it *reports* complexity, and the fresh session routes full-vs-lite from that report. The controller sees phase audit artifacts and the final unit result, but phase control remains inside the node session.

The launch must preflight that `craft-pool`, required phase agents, Graphify, required tools, provider-qualified models, and builder/evaluator model diversity are available. Missing capabilities fail closed before paid work begins. Pool-context bindings:

1. **Criteria provenance** — acceptance criteria always arrive from decomposition; C never authors them, and builds the test suite against them as ground truth.
2. **Criteria-to-A plumbing** — the Assess phase receives the node's *original* criteria through the controlled payload (not harness-propagated context), and audits the test suite against them, not just the code against the tests. Structural by construction: the primary agent spawns A directly, so A's payload is never mediated by C's interpretation.
3. **Model diversity** — builder (R/F) and evaluator (A) run on different models; A should be higher capability when available and must never be lower capability; fail closed if unenforceable.
4. **Audit emission** — every phase emits a schema-validated artifact using `docs/raw/specs/crafts-phase-artifact-contract.md`; invalid or prose-only output fails the phase. Validated artifacts are persisted to the audit trail.
5. **Context discipline** — each phase passes its structured output artifact forward, never its working transcript; phase boundaries are the compaction boundaries.
6. **Tool surface is pull, not push (ADR-029)** — phases receive their parent's payload plus on-demand tools installed in the container (`graphify` code graph, grep/LSP) and repo-resident knowledge (LLM wiki, skills). Grants are **scoped per phase**: R/F write, A read-only (an evaluator must not be able to edit what it judges), S writes docs only.
7. **Failure context survives compaction (ADR-026)** — a failing phase's artifact must carry what was attempted, why it failed, and discoveries made; retries receive prior failure artifacts in their payload and never start blind. Raw transcripts stay on disk, indexed in the audit trail by node + attempt as a human escape hatch — never injected into prompts.

## 6. Grading (ADR-004)

| Tier | Nature | Content |
|---|---|---|
| Tier 1 | Deterministic gate, binary, blocking | **red-state evidence (suite demonstrated failing pre-change, ADR-025)**, tests, lint, typecheck, static/security analysis, coverage delta |
| Tier 2 | Model-judged review (A phase) | criteria fit (hard floor gate) + maintainability score |
| Composite | tier-1 pass AND tier-2 above threshold | the value the controller reads; recorded for routing |

**The oracle must prove it can say no (ADR-025):** because C defines the tier-1 test strategy and R materializes the suite, a tautological always-pass suite would be an unchecked arbiter. The R phase's TDD loop is therefore enforced as a grading contract—red on the pre-change tree, green on the post-change tree—with command, pre/post commit SHA, suite path/hash, worker image/environment, and raw-output artifact references recorded. Suites that cannot fail are rejected mechanically at tier 1; A's suite audit sits above that deterministic floor.

Tier-2 scope was deliberately narrowed: `criteria_fit` acts as a gate (beautiful code solving the wrong problem must fail); `code_quality` = maintainability with a defined sub-rubric (needed only when A ships as a live gate — see §10 deferrals); `usability` dropped (inconsistently applicable, weakly LLM-judgeable); `regression_risk` deferred until the code graph can feed blast-radius evidence (ungrounded scoring is vibes).

Composite thresholds are **empirical** (ADR-009): derived per task class from Phase-1 eval score distributions, not hardcoded in advance. Before those distributions exist, the artifact contract's bootstrap gate applies: criteria fit passes only when every original criterion has direct evidence and no mismatch; maintainability scores are recorded for calibration, while any blocking maintainability finding fails closed.

## 7. Test Suites, Merge Arbitration, Re-Verification (ADR-017)

- The suite C produces is **written to the repo** (it must live in the tree to run); the node record holds path + content hash. Each revision during a node's execution records a new hash — the audit trail knows exactly which suite version graded each attempt.
- **Cross-node contention** on shared test files: optimistic concurrency — first to integrate wins; the second re-derives against the new head. Tests are just files under the same arbiter as source.
- **A node's `passed` is provisional.** Before PR assembly, tier 1 re-runs against the final merged suite. A sibling's suite change that breaks a previously-green node surfaces at integration and returns that node to `failed`/retry. Branch-integrated green is the real gate.

## 8. PR Assembly & the Revision Loop (ADR-015)

- **Granularity = DAG connected component.** Independent subtrees ship as separate PRs; a dependency chain is one PR with **one commit per node**, each commit carrying that node's scorecard, cost, and model rationale. Every PR includes the originating spec intent.
- **Review-comment revisions are governed continuations.** A PR comment fires the GitHub Action → orchestrator continuation endpoint → comment maps to a node (via its commit; PR-level comments map to the **latest affected node**; unmappable → escalate, don't guess) → dispatched as a normal node attempt: re-graded, counted against retry ceiling and budget, audit-logged. No write path to the PR bypasses grading.
- Operational TODO: author the GitHub Action (comment filter → orchestrator endpoint), pointing at the orchestrator rather than any worker-level endpoint.

## 9. Model Routing & the Eval Harness

### 9.1 Role-Indexed Routing (ADR-020)

Every model-call role is its own routing decision with its own eval task class: decomposition, planning (C), building (R/F), assessing (A), tightening (T), sharpening (S—likely no dedicated eval). Different rows, different winners; no single benchmark generalizes across roles.

Until eval-derived winners exist, `.pi/model-routing.bootstrap.json` is authoritative: Kimi K3 decomposes; Terra plans/conducts/diagnoses; Kimi K2.7 Code builds; Sol assesses and tightens; Luna sharpens. Sol is reserved from normal building so a different equal-or-higher evaluator remains available. Every launch passes an exact provider/model ID and fails closed if it is unavailable.

### 9.2 Harness Scope — Builder First (ADR-021, ADR-005, ADR-006, ADR-008)

Build the **R/F row only** first: self-graded (tests are the oracle — zero grader-design overhead), highest volume (best cost-routing ROI).

- **Dataset:** real tickets from kkchat and subba that already have tests (no retrofitting untested history); grows forward as new tickets land with acceptance tests (ADR-005).
- **Reps:** N=3 per task×model; raise selectively where results are inconsistent (ADR-006).
- **Matrix, phased (ADR-008):** Phase 1 = mid-tier Chinese lineup (Kimi K2.6, GLM-4.7, Qwen-Plus) — chosen on measured cost/benchmark strength; Phase 2 = full 3×3 across those providers; Phase 3 = Anthropic/OpenAI/Google. Harness measures a model *bare* — **"bare" means without CRAFTS phase structure, not without tools (ADR-030)**: eval runs get the same tool surface as a production builder, so the table measures the capability actually deployed (tool-use reliability included) rather than a configuration that never runs.
- **Provider-agnostic adapter (ADR-007):** all model calls go through one normalized contract; providers are config, not architecture.
- Deferred rows each have a named grader approach: decomposition & A = reference/fixture-based, C & S = judge, T = planted vulnerabilities.

SWE-bench and similar public benchmarks were rejected as the eval basis (representativeness, contamination, interview signal, shape mismatch) — retained only as an optional external sanity check.

## 10. Codebase Knowledge — Three Retrieval Modes (ADR-019 as refined by ADR-022)

| Mode | Serves | Mechanism |
|---|---|---|
| grep / LSP | builder (R/F) real-time lookup | exact, current; no RAG in the build path |
| Code graph | decomposer (hidden dependency edges); deferred `regression_risk` blast-radius | pluggable existing tool (tree-sitter / repo-map / LSP-class), not built from scratch |
| LLM wiki | prose/domain knowledge; S-phase authored | compounding interlinked pages; link/index navigation, not vector search |

Decomposer vs. C on the same knowledge: **breadth vs. depth** — the decomposer queries across units to draw boundaries; C queries within one unit to plan it. Vector embeddings are consciously absent (nothing in this system has the un-compiled-raw-corpus shape they serve); LLM-wiki failure modes accepted as obligations: S-phase lint/audit pass against sources; directory indexes past ~200 files.

## 11. Storage & Audit (ADR-014)

**SQLite**, single file, orchestrator-owned—justified by ADR-001 itself (one deterministic controller process = one writer). Holds DAG/node state, state versions, unique attempt/result records, models, evidence, findings, cost, suite hashes, escalations/resolutions, and routing results. Redis owns queue/session records. ADR-031 defines the practical cross-store idempotency and reconciliation contract. Multi-tenant scale-out remains a future deployment variant.

## 12. Implementation Stack

TypeScript end to end (shares runtime/types/job schema with BullMQ/Redis). No orchestration framework (§3.1). Thin per-provider adapters (§9.2). Single Hetzner-class host, Docker Compose, ~$10/month infrastructure posture.

The worker image pins Node, Pi, Graphify, Pi extension packages, and application dependencies. `.pi/runtime-versions.json` is the repository baseline; the image digest and dependency lockfiles are recorded with every attempt. Startup performs a capability preflight. `.pi/settings.json` enforces five exact models: GPT-5.6 Luna, Terra, and Sol through `openai-codex`, plus Moonshot Kimi K2.7 Code and Kimi K3. Anthropic and all unlisted models are excluded. `.pi/model-routing.bootstrap.json` defines the initial role mappings; eval-derived routing replaces these defaults when evidence exists.

ADR-033 defines the practical operations baseline: health/readiness checks, correlated structured logs, queue/disk/provider/cost visibility, WAL-safe encrypted off-host backups, tested restore guidance, migrations, and retention. Formal SLOs and a dedicated observability platform are fast-follow.

## 13. Deferred / Open Items

| Item | Status |
|---|---|
| `regression_risk` tier-2 dimension | Blocked on code-graph blast-radius feed |
| Non-builder eval rows (decomposition, C, A, T) | Deferred with named grader approaches |
| Mutation testing (hardening beyond red-state evidence, ADR-025) | Deferred; tautology class already killed deterministically |
| Graceful mid-node budget abort (phase-gate stop checks) | Deferred; overage accepted as bounded (§4.4) |
| HITL surface | CLI/API clients for v1; a dashboard is out of scope |
| Decomposition schema-invalid retry/repair loop | Implementation-level |
| Repo onboarding / Graphify index build | Required implementation slice: pin Graphify in the worker image; build per workspace and refresh after re-derivation |
| GitHub Action for comment→continuation | Operational TODO (§8) |
| Swarm-pattern build | Separate future project — see `swarm-pattern-open-questions.md` and its handoff |

## 14. ADR Index

| ADR | Decision |
|---|---|
| 001 | Deterministic controller, not agentic orchestrator |
| 002 | Fuzzy-in / structured-out spec boundary |
| 003 | DAG as human-gated checkpoint |
| 004 | Tiered grading (tier 1 + tier 2 composite) |
| 005 | Ticket-sourced eval dataset, tested-only |
| 006 | N=3 reliability reps |
| 007 | Provider-agnostic model interface |
| 008 | Phased run matrix, Chinese lineup first |
| 009 | Empirical routing thresholds |
| 010 | DAG-level orchestration, node-level dispatch |
| 011 | Failed nodes freeze their branch, not the DAG |
| 012 | Fixed global retry ceiling; overrides downward only |
| 013 | Dual-level budget guardrail (per-node, per-DAG) |
| 014 | SQLite audit trail |
| 015 | PR per connected component; commit per node; intent included |
| 016 | Fixed escalation resolution actions |
| 017 | Suite storage, versioning, re-verification at integration |
| 018 | Decomposition emission schema; emit-vs-derive split |
| 019 | Shared codebase retrieval for decomposer + C (breadth vs. depth) — refined by 022 |
| 020 | Role-indexed routing table |
| 021 | Eval scope: builder (R/F) first |
| 022 | Codebase knowledge: three retrieval modes; no vector embeddings |
| 023 | Failure-class retry counters (logic vs. integration) |
| 024 | Amend-DAG: fifth escalation resolution action |
| 025 | Red-state tier-1 evidence: the suite must prove it can fail |
| 026 | Failure-context artifacts + transcript index |
| 027 | Spec intake API; async decomposition; separate orchestrator queue |
| 028 | Direct task path; hand-authored DAGs; proportionate ceremony |
| 029 | Agent tool surface: pull not push; per-phase capability scoping |
| 030 | Eval tool parity: "bare" = no CRAFTS, not no tools |
| 031 | Practical v1 delivery idempotency; stronger atomicity deferred |
| 032 | Practical v1 worker isolation baseline |
| 033 | Practical v1 single-host operations baseline |
| 034 | Domain discovery before implementation |
