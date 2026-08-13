---
title: Wiki Index
type: index
tags: [index]
created: 2026-07-22
updated: 2026-08-05
sources:
  - docs/raw/
---

# Wiki Index

First lookup page for repository knowledge. Use wiki pages first; open raw artifacts only for exact requirements, rationale, or conflict resolution.

## Core pages

- [[wiki/overview|Project Overview]]
- [[wiki/product/agent-pool|Warm Agent Pool]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/architecture/initial-domain-map|Initial Domain Map (approved)]]
- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]
- [[wiki/output/agents-building-agents-handoff|Agents Building Agents Handoff]]
- [[wiki/log|Activity Log]]
- [[wiki/operations/test-governance|Test Governance]]

## Source pages

- [[wiki/sources/2026-04-13_domain-driven-documentation-convention|Domain-Driven Documentation Convention]] — `docs/raw/context/domain-driven-documentation-convention.md`
- [[wiki/sources/2026-08-13_test-governance|Test Governance]] — `docs/raw/context/test-governance.md`
- [[wiki/sources/2026-04-13_initial-domain-map|Initial Domain Map]] — `docs/raw/context/initial-domain-map.md`
- [[wiki/sources/2026-04-13_repository-builder-vs-pool-worker|Repository Builder and Pool Worker Role Boundary]] — `docs/raw/context/repository-builder-vs-pool-worker.md`
- [[wiki/sources/2026-04-13_pool-worker-execution-context-schema|Pool Worker Execution Context Schema]] — `docs/raw/specs/schemas/pool-worker-execution-context.schema.json`
- [[wiki/sources/2026-07-31_pool-worker-attempt-contract-schema|Pool Worker Attempt Contract Schema]] — `docs/raw/specs/schemas/pool-worker-attempt-contract.schema.json`
- [[wiki/sources/2026-07-22_orchestrator-spec|Supervisor Orchestrator — Consolidated Specification]] — `docs/raw/specs/orchestrator-spec.md`
- [[wiki/sources/2026-07-22_adr-001-deterministic-controller-vs-agentic-orchestrator|ADR-001: Deterministic Controller vs. Agentic Orchestrator]] — `docs/raw/adr/orchestrator/ADR-001-deterministic-controller-vs-agentic-orchestrator.md`
- [[wiki/sources/2026-07-22_adr-002-fuzzy-in-structured-out-spec-boundary|ADR-002: Fuzzy-In / Structured-Out Spec Boundary]] — `docs/raw/adr/orchestrator/ADR-002-fuzzy-in-structured-out-spec-boundary.md`
- [[wiki/sources/2026-07-22_adr-003-dag-as-gated-checkpoint|ADR-003: DAG as Gated Checkpoint]] — `docs/raw/adr/orchestrator/ADR-003-dag-as-gated-checkpoint.md`
- [[wiki/sources/2026-07-22_adr-004-tiered-grading-not-tests-as-sole-grader|ADR-004: Tiered Grading, Not Tests-as-Sole-Grader]] — `docs/raw/adr/orchestrator/ADR-004-tiered-grading-not-tests-as-sole-grader.md`
- [[wiki/sources/2026-07-22_adr-005-ticket-sourced-eval-dataset-tested-only|ADR-005: Ticket-Sourced Eval Dataset, Tested-Only]] — `docs/raw/adr/orchestrator/ADR-005-ticket-sourced-eval-dataset-tested-only.md`
- [[wiki/sources/2026-07-22_adr-006-n3-reliability-reps|ADR-006: N=3 Reliability Reps Per Task]] — `docs/raw/adr/orchestrator/ADR-006-n3-reliability-reps.md`
- [[wiki/sources/2026-07-22_adr-007-provider-agnostic-model-interface|ADR-007: Provider-Agnostic Model Interface]] — `docs/raw/adr/orchestrator/ADR-007-provider-agnostic-model-interface.md`
- [[wiki/sources/2026-07-22_adr-008-phased-run-matrix-chinese-lineup-first|ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First]] — `docs/raw/adr/orchestrator/ADR-008-phased-run-matrix-chinese-lineup-first.md`
- [[wiki/sources/2026-07-22_adr-009-empirical-routing-threshold|ADR-009: Empirical Routing Threshold, Not Hardcoded]] — `docs/raw/adr/orchestrator/ADR-009-empirical-routing-threshold.md`
- [[wiki/sources/2026-07-22_adr-010-dag-orchestration-node-level-dispatch|ADR-010: DAG-Level Orchestration, Node-Level Queue Dispatch]] — `docs/raw/adr/orchestrator/ADR-010-dag-orchestration-node-level-dispatch.md`
- [[wiki/sources/2026-07-22_adr-011-failed-nodes-freeze-branch|ADR-011: Failed Nodes Freeze Their Branch, Not the DAG]] — `docs/raw/adr/orchestrator/ADR-011-failed-nodes-freeze-branch.md`
- [[wiki/sources/2026-07-22_adr-012-fixed-global-retry-ceiling|ADR-012: Fixed Global Retry Ceiling, Per-Class Override Downward Only]] — `docs/raw/adr/orchestrator/ADR-012-fixed-global-retry-ceiling.md`
- [[wiki/sources/2026-07-22_adr-013-dual-level-budget-guardrail|ADR-013: Dual-Level Budget Guardrail — Per-Node and Per-DAG]] — `docs/raw/adr/orchestrator/ADR-013-dual-level-budget-guardrail.md`
- [[wiki/sources/2026-07-22_adr-014-sqlite-audit-trail|ADR-014: SQLite for Audit Trail, Not Postgres]] — `docs/raw/adr/orchestrator/ADR-014-sqlite-audit-trail.md`
- [[wiki/sources/2026-07-22_adr-015-pr-granularity-by-connected-component|ADR-015: PR Granularity by DAG Connected Component, With Intent]] — `docs/raw/adr/orchestrator/ADR-015-pr-granularity-by-connected-component.md`
- [[wiki/sources/2026-07-22_adr-016-fixed-escalation-resolution-actions|ADR-016: Fixed Escalation Resolution Actions]] — `docs/raw/adr/orchestrator/ADR-016-fixed-escalation-resolution-actions.md`
- [[wiki/sources/2026-07-22_adr-017-test-suite-storage-and-reverification|ADR-017: Test Suite Storage, Versioning, and Re-Verification at Integration]] — `docs/raw/adr/orchestrator/ADR-017-test-suite-storage-and-reverification.md`
- [[wiki/sources/2026-07-22_adr-018-decomposition-emission-schema|ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split]] — `docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md`
- [[wiki/sources/2026-07-22_adr-019-shared-codebase-rag-layer|ADR-019: Shared Codebase-RAG Layer Serving Decomposer and C]] — `docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md`
- [[wiki/sources/2026-07-22_adr-020-role-indexed-routing-table|ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role]] — `docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md`
- [[wiki/sources/2026-07-22_adr-021-eval-scope-builder-first|ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred]] — `docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md`
- [[wiki/sources/2026-07-22_adr-022-codebase-knowledge-three-retrieval-modes|ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer]] — `docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md`
- [[wiki/sources/2026-07-22_adr-023-failure-class-retry-counters|ADR-023: Failure-Class Retry Counters — Logic vs. Integration]] — `docs/raw/adr/orchestrator/ADR-023-failure-class-retry-counters.md`
- [[wiki/sources/2026-07-22_adr-024-amend-dag-resolution-action|ADR-024: Amend-DAG — Fifth Escalation Resolution Action]] — `docs/raw/adr/orchestrator/ADR-024-amend-dag-resolution-action.md`
- [[wiki/sources/2026-07-22_adr-025-red-state-tier1-evidence|ADR-025: Red-State Evidence — The Test Suite Must Prove It Can Fail]] — `docs/raw/adr/orchestrator/ADR-025-red-state-tier1-evidence.md`
- [[wiki/sources/2026-08-13_adr-035-minimal-coherent-dag-nodes|ADR-035: Minimal Coherent DAG Nodes]] — `docs/raw/adr/orchestrator/ADR-035-minimal-coherent-dag-nodes.md`
- [[wiki/sources/2026-08-13_adr-036-discovered-work-and-dag-amendment|ADR-036: Discovered Work Records and Governed DAG Amendment]] — `docs/raw/adr/orchestrator/ADR-036-discovered-work-and-dag-amendment.md`
- [[wiki/sources/2026-07-22_adr-026-failure-context-artifacts|ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch]] — `docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md`
- [[wiki/sources/2026-04-13_adr-027-spec-intake-api|ADR-027: Spec Intake API]]
- [[wiki/sources/2026-04-13_adr-028-direct-task-path|ADR-028: Direct Task Path]]
- [[wiki/sources/2026-04-13_adr-029-agent-tool-surface-and-phase-scoping|ADR-029: Phase-Scoped Agent Tools]]
- [[wiki/sources/2026-04-13_adr-030-eval-tool-parity|ADR-030: Eval Tool Parity]]
- [[wiki/sources/2026-04-13_adr-031-practical-delivery-idempotency|ADR-031: Practical Delivery Idempotency]]
- [[wiki/sources/2026-04-13_adr-032-practical-worker-isolation-baseline|ADR-032: Practical Worker Isolation]]
- [[wiki/sources/2026-04-13_adr-033-practical-single-host-operations-baseline|ADR-033: Practical Operations Baseline]]
- [[wiki/sources/2026-04-13_adr-034-domain-discovery-before-implementation|ADR-034: Domain Discovery Gate]]
- [[wiki/sources/2026-04-13_crafts-phase-artifact-contract|CRAFTS Phase Artifact Contract]]
- [[wiki/sources/2026-04-13_v1-roadmap|v1 Roadmap]]
- [[wiki/sources/2026-07-25_approved-v1-build-dag|Superseded Repository Builder v1 Build DAG]] — historical full-v1 build sequence
- [[wiki/sources/2026-08-05_pool-proof-specification|Pool Proof Specification (Approved Build Phase)]] — `docs/raw/specs/pool-proof.md`; canonical DAG at `docs/raw/plans/proposed-build-dag.json`
