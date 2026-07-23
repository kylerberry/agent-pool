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
- The pool receives flat, atomic queue jobs and does not need DAG awareness.
- Failed nodes freeze only their dependent branch; unrelated ready branches continue.

## Gating and evidence

- Decomposition output is persisted and human-approved before dispatch.
- Tier 1 is deterministic and blocking: tests, lint, typecheck, static/security checks, and required red/green evidence.
- Tier 2 is model-scored against a rubric and informs human review and eval data.
- Attempts carry failure-context artifacts so retries do not start blind.

## Related

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/product/agent-pool|Warm Agent Pool]]
