---
title: Supervisor Orchestrator
type: architecture
tags: [orchestrator, dag, agents]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/specs/orchestrator-spec.md
  - docs/raw/adr/orchestrator/
---

# Supervisor Orchestrator

The supervisor orchestrator accepts a free-form feature spec, decomposes it into a validated DAG of verifiable work units, gates that DAG for human approval, dispatches ready nodes to a warm agent pool, grades attempts, and assembles reviewable GitHub outputs with an audit trail.

## Operating model

- Deterministic controller owns sequencing, retries, budgets, escalation, DAG state, and PR assembly.
- Models are used at named checkpoints: decomposition, phase work, review/adjudication, and deferred failure diagnosis.
- Decomposition runs through a separate orchestrator-side harness/queue and produces ADR-018 output for deterministic validation and Gate 1; it is not a Pool Worker capability.
- The pool receives flat, atomic queue jobs and does not need DAG awareness.
- Each node launches a fresh Pool Worker Pi session with the explicitly loaded `packages/worker-harness/`; it conducts CRAFTS through sequential `pi-subagents` phase calls.
- v1 delivery uses stable attempt IDs, idempotent results, CAS transitions, leases, and startup reconciliation.
- Failed nodes freeze only their dependent branch; unrelated ready branches continue.

## Gating and evidence

- Decomposition output is persisted and human-approved before dispatch.
- Tier 1 is deterministic and blocking: tests, lint, typecheck, static/security checks, and required red/green evidence.
- Tier 2 applies a binary evidence-backed criteria-fit gate and anchored maintainability rubric; empirical thresholds replace bootstrap mode after calibration.
- Every phase emits a schema-valid artifact; attempts carry failure context so retries do not start blind.

## Implementation readiness

- Domain discovery and human approval precede feature implementation.
- Workers pin Pi, Node, Graphify, and extension versions and preflight capabilities.
- Practical worker isolation and single-host recovery controls are required for v1; stronger enterprise hardening is tracked as fast-follow work.
- Pi model selection is restricted to five exact OpenAI/Moonshot models. Bootstrap role mappings are committed and will be replaced by eval-derived routing.

## Related

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/product/agent-pool|Warm Agent Pool]]
