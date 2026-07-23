---
title: Orchestrator ADR Map
type: architecture
tags: [adr, orchestrator, architecture]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/
---

# Orchestrator ADR Map

This page indexes the initial supervisor-orchestrator ADR set and groups the decisions future agents must check before changing orchestration behavior.

## Decision index

- `ADR-001-deterministic-controller-vs-agentic-orchestrator.md` — ADR-001: Deterministic Controller vs. Agentic Orchestrator: Deterministic controller. Control flow — sequencing, retry ceilings, budget enforcement, escalation triggers, PR assembly — lives in code. Models are invoked only at named checkpoints (decomposition, review adjudication, failure diagnosis) and their output fee
- `ADR-002-fuzzy-in-structured-out-spec-boundary.md` — ADR-002: Fuzzy-In / Structured-Out Spec Boundary: No prescribed input format. A model-driven decomposition step accepts free-form markdown and normalizes it into a validated DAG schema. The deterministic controller only ever consumes the normalized DAG — never the raw spec.
- `ADR-003-dag-as-gated-checkpoint.md` — ADR-003: DAG as Gated Checkpoint: Persist the decomposition output and require human approval before dispatch to the queue. Re-runs and retries resume from the approved DAG, not from a fresh decomposition call.
- `ADR-004-tiered-grading-not-tests-as-sole-grader.md` — ADR-004: Tiered Grading, Not Tests-as-Sole-Grader: Two-tier grading. - **Tier 1 (deterministic, blocking):** tests, lint, typecheck, static/security analysis, coverage delta — binary pass/fail, necessary but not sufficient. - **Tier 2 (model-judged):** a second model scores acceptance-criteria fit, code qualit
- `ADR-005-ticket-sourced-eval-dataset-tested-only.md` — ADR-005: Ticket-Sourced Eval Dataset, Tested-Only: Seed set = any ticket from either codebase that already has a test. No retrofitting untested history. Dataset grows forward as new subba tickets are written with acceptance tests as standard practice.
- `ADR-006-n3-reliability-reps.md` — ADR-006: N=3 Reliability Reps Per Task: Each task × model runs 3 times at Phase 1. Raise to 5+ later only for task classes showing inconsistent results.
- `ADR-007-provider-agnostic-model-interface.md` — ADR-007: Provider-Agnostic Model Interface: All model calls go through a thin per-provider adapter normalized to one input/output contract. Providers are interchangeable configuration, not architecture — the orchestrator and routing table have no provider-specific logic.
- `ADR-008-phased-run-matrix-chinese-lineup-first.md` — ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First: - **Phase 1:** mid-tier only from Moonshot, Z.ai, Qwen (3 models) — chosen on cost and reasoning/coding benchmark strength (e.g. GLM-4.7 at 73.8% SWE-bench Verified, $0.60/$2.20), not as a placeholder. - **Phase 2:** expand to full 3×3 Chinese-provider matrix.
- `ADR-009-empirical-routing-threshold.md` — ADR-009: Empirical Routing Threshold, Not Hardcoded: No threshold is fixed in advance. Per-task-class thresholds are derived from the actual Phase 1 score distribution once real runs exist — picked at a natural separation point between tiers, not an arbitrary round number.
- `ADR-010-dag-orchestration-node-level-dispatch.md` — ADR-010: DAG-Level Orchestration, Node-Level Queue Dispatch: One queue ticket = one DAG node, never the whole DAG. Each round, the orchestrator enqueues one self-contained ticket (change spec + acceptance criteria) for every node whose dependencies are complete — the ready frontier — as independent, unrelated-looking jo
- `ADR-011-failed-nodes-freeze-branch.md` — ADR-011: Failed Nodes Freeze Their Branch, Not the DAG: A failed node never enters completed state, so its dependents simply never become ready — they freeze, not cancel. The failed node escalates to a human per the retry-ceiling envelope. Unrelated branches keep executing in parallel, unaffected. Frozen dependents
- `ADR-012-fixed-global-retry-ceiling.md` — ADR-012: Fixed Global Retry Ceiling, Per-Class Override Downward Only: A single global retry ceiling (e.g., 3) applies to every unit by default. Per-task-class overrides are permitted only to lower the ceiling, never raise it — a class can fail faster, never slower.
- `ADR-013-dual-level-budget-guardrail.md` — ADR-013: Dual-Level Budget Guardrail — Per-Node and Per-DAG: Two independent ceilings. - **Per-node:** a unit blowing its budget is treated as a retry-ceiling failure — stop, escalate per ADR-011. - **Per-DAG (aggregate):** hitting it halts further dispatch (no new ready-frontier nodes go out) but lets in-flight nodes f
- `ADR-014-sqlite-audit-trail.md` — ADR-014: SQLite for Audit Trail, Not Postgres: SQLite, single file, owned by the orchestrator process. Justified by ADR-001's own architecture: the orchestrator is one deterministic-controller process, so there's exactly one writer — SQLite's classic single-writer limitation never applies here.
- `ADR-015-pr-granularity-by-connected-component.md` — ADR-015: PR Granularity by DAG Connected Component, With Intent: PR granularity follows the DAG's independent connected components — genuinely unrelated subtrees ship as separate PRs; a single dependency chain stays one PR by necessity but is structured as one commit per node, each carrying its own tier-1/tier-2 scorecard, 
- `ADR-016-fixed-escalation-resolution-actions.md` — ADR-016: Fixed Escalation Resolution Actions: Four fixed resolution actions: 1. **Retry** (with optional task/context edit) — retry count resets, node redispatches through the normal pipeline. 2. **Manual fix** — human supplies the change directly, node marked complete, dependents unfreeze. 3. **Cancel br
- `ADR-017-test-suite-storage-and-reverification.md` — ADR-017: Test Suite Storage, Versioning, and Re-Verification at Integration: **Storage:** the test suite is written to the repo where it executes; the node record holds the path plus a content hash. Not stored inline in SQLite — it's real code that must live in the tree to run (tier-1 executes it, builder builds against it, it ships in
- `ADR-018-decomposition-emission-schema.md` — ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split: The DAG is a **flat list of nodes**, each carrying a `depends_on: [nodeId]` array — not a nested tree. A DAG allows convergence (a node with multiple parents), which a tree cannot represent without duplication; a flat edge list is the honest encoding and is me
- `ADR-019-shared-codebase-rag-layer.md` — ADR-019: Shared Codebase-RAG Layer Serving Decomposer and C: Introduce a **codebase-RAG layer** (embeddings, vector search, context injection over the target repo) as a **shared retrieval capability** consumed by both the decomposer and C — one pipeline, two consumers, queried at different granularities. The two phases 
- `ADR-020-role-indexed-routing-table.md` — ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role: The routing table is **role-indexed**: every CRAFTS phase that is a model call is its own routing decision, with its own eval task class and its own "best perf/cost model" derived from that class. A model strong at building may be mediocre at decomposition — d
- `ADR-021-eval-scope-builder-first.md` — ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred: Build the **builder (R/F) eval row first, and only it, for now**: - **Self-graded** — tier-1 (test execution) is the oracle; no rubric, no judge, no reference-matching to design. - **Highest-volume role** — routing-by-cost saves the most here, so best ROI. - D
- `ADR-022-codebase-knowledge-three-retrieval-modes.md` — ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer: Three retrieval modes, each matched to a knowledge shape: 1. **Grep / LSP — precise, real-time code lookup (builder / R/F).** When the builder hits an unforeseen problem and needs surrounding code, it needs exact current lookups ("where is this defined, what's
- `ADR-023-failure-class-retry-counters.md` — ADR-023: Failure-Class Retry Counters — Logic vs. Integration: Attempt failures are **classified** and counted separately: - **`logic` failure** — the node's own defect: tier-1 red on its own suite, tier-2 below threshold, build error. Counts against the ADR-012 retry ceiling (default 3). - **`integration` failure** — a p
- `ADR-024-amend-dag-resolution-action.md` — ADR-024: Amend-DAG — Fifth Escalation Resolution Action: Add a fifth, human-initiated resolution action: **amend-DAG** (partial re-decomposition). Mechanics: 1. Human cancels the affected subtree (existing cancel-branch semantics). 2. The decomposer re-runs against **only the unmet remainder** of the spec intent, re
- `ADR-025-red-state-tier1-evidence.md` — ADR-025: Red-State Evidence — The Test Suite Must Prove It Can Fail: **Red-state evidence is a tier-1 requirement.** The R phase's TDD loop is enforced, not advisory: before implementation, the suite (or each new test) must be executed against the pre-change tree and **demonstrated failing**, with the red-run output captured as
- `ADR-026-failure-context-artifacts.md` — ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch: Two mechanisms, primary and escape hatch: 1. **Failure-context artifact section (primary).** A failing phase's emitted artifact MUST include: what was attempted, why it failed, and discoveries made (edge cases, surprising behavior, ruled-out dead ends). Retry 

## Main themes

- Deterministic control flow owns retries, budgets, dispatch, escalation, and audit state.
- Model calls are bounded checkpoints with structured outputs.
- Work is decomposed into an approved DAG, dispatched as node-level queue jobs, and gated by tiered grading.
- Reliability, routing, and model choice are empirically evaluated rather than guessed.
- Failure handling preserves context, freezes dependent branches, and records human overrides.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/product/agent-pool|Warm Agent Pool]]
