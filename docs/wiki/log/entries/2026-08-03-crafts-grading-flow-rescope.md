---
title: crafts-grading-flow rescoped to attempt-provenance-store
type: operation
tags: [orchestration, goal-ledger, plan-amendment, crafts]
created: 2026-08-03
updated: 2026-08-03
sources:
  - docs/raw/plans/handoff-crafts-grading-flow-attempt-1.md
  - docs/raw/plans/proposed-build-dag.json
---

# crafts-grading-flow rescoped to `attempt-provenance-store`

`crafts-grading-flow-attempt-1` stopped on an open human-decision gate after two
plan-security rounds both returned `needs-replan`. `defer-and-proceed` was
illegal (checkpoint 2 carried two `high` findings) and the replan loop was capped
at `psCount < 2`, leaving `stop-and-rescope` as the only accepted outcome.

## Decision

Recorded at `decisions/crafts-grading-flow/crafts-grading-flow-attempt-1/decision-1.json`
(`98c4ead8…0248`), bound to plan-security checkpoint 2 (`87148e6b…6364`).
`record-decision` auto-completed the node as `escalated`.

Both blockers were scope-shaped rather than plan-quality-shaped:

- **PS2-1** — the specified `UNIQUE(attempt_id, phase)` artifact key is disproven
  by this repository's own journal, where `controller-ready-frontier` F/T repeat
  within a single attempt. It would reject a `needs_fix` T and its subsequent
  passing T, defeating acceptance criterion 5.
- **PS2-2** — the evaluator-independence remedy reads a routing decision keyed by
  `attempt_id` that has no producer in source. `RoutingDecision` is a transient
  return of `selectForRole` with no `attempt_id` association, so the reader is
  satisfiable only by a test fake.

Both land in orchestration and model-routing territory, not this node's.

## Plan amendment

Amendment 4 moved the plan from `72f34c3c…c54b4` to `0579607f…df524`
(17 nodes), approved by Kyler against that exact hash.

New upstream node **`attempt-provenance-store`** (`depends_on:
model-routing-foundation`, `isolated-pool-worker-execution`) owns
attempt-scoped routing-decision persistence written at dispatch and a
phase-artifact store keyed by `(attempt_id, phase, revision)` with a
store-assigned monotonic revision allocated inside the insert transaction.
Immutability is expressed as "no revision is ever updated or deleted".

`crafts-grading-flow` now depends on it and returned to `pending`, retaining its
escalated attempt-1 history. It keeps artifact validation, criteria fidelity,
Tier-1 provenance, sanitization, and sink provenance.

## Runtime deviation

Attempt-1 ran in Claude Code rather than Pi under owner override after preflight
failed closed. C and plan-security ran on `anthropic/claude-opus-5` against pins
of `openai-codex/gpt-5.6-sol` and `-terra`, and `.pi/extensions/eval-telemetry`
did not load, so cost is `0`/`null`. **These artifacts are not eligible as
routing-eval fixtures.**

## Frontier

`async-spec-intake-gate-one`, `attempt-provenance-store`, `controller-failure-policy`.
