---
title: Supervisor Orchestrator
type: architecture
tags: [orchestrator, dag, agents]
created: 2026-07-22
updated: 2026-08-21
sources:
  - docs/raw/specs/orchestrator-spec.md
  - docs/raw/adr/orchestrator/
---

# Supervisor Orchestrator

The supervisor orchestrator accepts a free-form feature spec, decomposes it into a validated DAG of verifiable work units, gates that DAG for human approval, dispatches ready nodes to a warm agent pool, grades attempts, and assembles reviewable GitHub outputs with an audit trail.

## Current build phase

Pool Proof is complete. The 17-node functional deployment plan approved on 2026-08-15 was superseded on 2026-08-16 before its root started; its bytes are archived at `docs/raw/plans/superseded-functional-deployment-build-dag.json`. The active plan is the four-node replacement milestone. `generalize-proven-runner` and `compose-direct-intake-to-execution` are complete: authenticated single-unit `POST /tasks` persists through SQLite and a claim loop launches one Minimal Pool Runtime Worker. Remaining nodes: `general-deterministic-verifier` and `surface-reviewable-output`. Tier-2 grading, budgets, discovery quarantine, Redis/BullMQ, component PR assembly, automated Gate 2, and the operations baseline remain deferred until the tracer path demonstrates need.

## Operating model

- Deterministic controller owns sequencing, retries, budgets, escalation, DAG state, and PR assembly.
- Models are used at named checkpoints: decomposition, post-launch one-call probing, phase work, review/adjudication, and deferred failure diagnosis.
- Decomposition runs through a separate orchestrator-side harness/queue and produces ADR-018 output for deterministic validation and Gate 1; it is not a Pool Worker capability. Each node is the smallest independently verifiable vertical slice that preserves correctness, with explicit non-goals and a review rationale for any inseparable cross-domain or multi-contract scope (ADR-035).
- The pool receives flat, atomic queue jobs and does not need DAG awareness.
- Each node launches a fresh Pool Worker Pi session with the explicitly loaded `packages/worker-harness/`. Normal implementation nodes conduct sequential CRAFTS; only an explicitly approved controller-owned ADR-039 probe profile may use one probing call outside CRAFTS.
- Codebase knowledge is target-repository scoped: bounded controller caches hold regenerable graph data, while prose knowledge is read from the target repository's own docs or approved provider. Missing wiki/docs are non-blocking; Agent Pool product docs are not exposed as knowledge for another target.
- Orchestration is the sole SQLite writer. It derives deterministic attempt and job IDs, sends identifier-only queue envelopes, rehydrates and deep-freezes one topology-free worker contract at consumption, and uses CAS lifecycle transitions, lease generation/token fencing, idempotent result acceptance, and startup reconciliation to recover interrupted windows.
- SQLite startup is gated on an owner-only private runtime path, no symlink or non-regular database target, foreign keys/WAL, and fail-closed versioned migrations. Gate-1-bound, versioned controller-owned predicted-touch evidence may serialize confident likely overlaps without changing approved DAG edges; stale, unavailable, mismatched, or low-confidence evidence uses optimistic concurrency and records its decision.
- Failed nodes freeze only their dependent branch; unrelated ready branches continue. Workers may report bounded, provenance-linked discovered work but cannot widen their node, alter priorities, or change topology. The controller classifies it as backlog, a blocker, or a human-approved ADR-024 amendment candidate; passed work remains immutable (ADR-036).

## Gating and evidence

- Decomposition output is persisted and human-approved before dispatch.
- Structural DAG validation is not the product-runtime dispatch gate; decomposition output is persisted and human-approved before dispatch.
- Tier 1 is deterministic and blocking: tests, lint, typecheck, static/security checks, and required red/green evidence.
- Tier 2 applies a binary evidence-backed criteria-fit gate and anchored maintainability rubric; empirical thresholds replace bootstrap mode after calibration.
- Every phase emits a schema-valid artifact; attempts carry failure context so retries do not start blind.

## Implementation readiness

- Domain discovery and human approval precede feature implementation.
- Workers pin Pi, Node, Graphify, and extension versions and preflight capabilities.
- Practical worker isolation and single-host recovery controls are required for v1. P0 fast-follow hardening adds content-level secret scanning/redaction, OS default-deny egress, OS read-only mount/sandbox isolation, and reproducible worker-image smoke attestation for pinned Graphify/runtime capabilities.
- Model routing uses seven exact target IDs and tie-capable provisional tiers. GLM-5.2/Terra/Kimi K2.7 Code are standard; GLM-5.3/Sol/Kimi K3 are high; Luna is lower. Building bootstraps GLM-5.2→Kimi K2.7 Code. Moonshot is always fallback, never primary. Z.ai remains ineligible until real qualification; eval calibration is post-launch.
- The orchestrator-side decomposition harness is physically separate from Pool Worker resources. Free-form decomposition is post-launch, and its legacy Kimi-primary bootstrap must migrate before activation because Moonshot is fallback-only. Exact ADR-018 validation, bounded repair, immutable provenance, pinned/reverified Pi, minimal environment, private runtime, and controlled cleanup remain required.
- ADR-039 defines a post-launch one-call probe profile: GLM-5.3→Kimi K3, strict evidence schema, deterministic validation, and bounded projection into later C. It is not CRAFTS and cannot become controller authority.

## Related

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/product/agent-pool|Warm Agent Pool]]
- [[wiki/sources/2026-08-13_functional-pool-deployment|Functional Pool Deployment]]
- [[wiki/sources/2026-08-13_adr-039-agent-assisted-probe-execution|ADR-039: Agent-Assisted Probe Execution]]
