---
title: Supervisor Orchestrator
type: architecture
tags: [orchestrator, dag, agents]
created: 2026-07-22
updated: 2026-08-05
sources:
  - docs/raw/specs/orchestrator-spec.md
  - docs/raw/adr/orchestrator/
---

# Supervisor Orchestrator

The supervisor orchestrator accepts a free-form feature spec, decomposes it into a validated DAG of verifiable work units, gates that DAG for human approval, dispatches ready nodes to a warm agent pool, grades attempts, and assembles reviewable GitHub outputs with an audit trail.

## Current build phase

The approved Pool Proof precedes further supervisor governance. It builds and verifies the Minimal Pool Runtime against a controlled fixture using direct atomic jobs, one then two ready slots, fresh headless Worker sessions, deterministic results, and one contained Worker-process failure. Decomposition, grading, GitHub delivery, full failure policy, and operations remain authoritative v1 targets but are not Pool Proof prerequisites.

## Operating model

- Deterministic controller owns sequencing, retries, budgets, escalation, DAG state, and PR assembly.
- Models are used at named checkpoints: decomposition, phase work, review/adjudication, and deferred failure diagnosis.
- Decomposition runs through a separate orchestrator-side harness/queue and produces ADR-018 output for deterministic validation and Gate 1; it is not a Pool Worker capability. Each node is the smallest independently verifiable vertical slice that preserves correctness, with explicit non-goals and a review rationale for any inseparable cross-domain or multi-contract scope (ADR-035).
- The pool receives flat, atomic queue jobs and does not need DAG awareness.
- Each node launches a fresh Pool Worker Pi session with the explicitly loaded `packages/worker-harness/`; it conducts CRAFTS through sequential `pi-subagents` phase calls.
- Codebase knowledge is target-repository scoped: bounded controller caches hold regenerable graph data, while prose knowledge is read from the target repository's own docs or approved provider. Missing wiki/docs are non-blocking; Agent Pool product docs are not exposed as knowledge for another target.
- Orchestration is the sole SQLite writer. It derives deterministic attempt and job IDs, sends identifier-only queue envelopes, rehydrates and deep-freezes one topology-free worker contract at consumption, and uses CAS lifecycle transitions, lease generation/token fencing, idempotent result acceptance, and startup reconciliation to recover interrupted windows.
- SQLite startup is gated on an owner-only private runtime path, no symlink or non-regular database target, foreign keys/WAL, and fail-closed versioned migrations. Gate-1-bound, versioned controller-owned predicted-touch evidence may serialize confident likely overlaps without changing approved DAG edges; stale, unavailable, mismatched, or low-confidence evidence uses optimistic concurrency and records its decision.
- Failed nodes freeze only their dependent branch; unrelated ready branches continue. Workers may report bounded, provenance-linked discovered work but cannot widen their node, alter priorities, or change topology. The controller classifies it as backlog, a blocker, or a human-approved ADR-024 amendment candidate; passed work remains immutable (ADR-036).

## Gating and evidence

- Decomposition output is persisted and human-approved before dispatch.
- Tier 1 is deterministic and blocking: tests, lint, typecheck, static/security checks, and required red/green evidence.
- Tier 2 applies a binary evidence-backed criteria-fit gate and anchored maintainability rubric; empirical thresholds replace bootstrap mode after calibration.
- Every phase emits a schema-valid artifact; attempts carry failure context so retries do not start blind.

## Implementation readiness

- Domain discovery and human approval precede feature implementation.
- Workers pin Pi, Node, Graphify, and extension versions and preflight capabilities.
- Practical worker isolation and single-host recovery controls are required for v1. P0 fast-follow hardening adds content-level secret scanning/redaction, OS default-deny egress, OS read-only mount/sandbox isolation, and reproducible worker-image smoke attestation for pinned Graphify/runtime capabilities.
- Model routing uses an exact provider-qualified registry, actor-separated source-bound bootstrap fixtures, deterministic routing over validated availability, fail-closed explicit selection, atomic builder/evaluator constraints, provider-neutral injected adapters, and immutable credential-free evidence. Bootstrap ranks are provisional; replacement requires validated eval-derived publications, not yet an eval harness, live provider availability, or audit persistence.
- The orchestrator-side decomposition harness is physically separate from Pool Worker resources. Deterministic Work Intake sanitizes and bounds inputs, retrieves revision-bound breadth context, selects bootstrap Kimi K3 or only the approved Sol fallback, and validates exact ADR-018 output with at most one schema-only repair. The adapter executes that exact provider-qualified selection. Immutable provenance binds the sanitized prompt, routing decision, breadth tool/revision, package identity, and Pi path/version/digest. Launch uses a trusted interpreter, pinned/reverified Pi bytes, minimal environment, private runtime subtree, and controlled cleanup.

## Related

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/product/agent-pool|Warm Agent Pool]]
