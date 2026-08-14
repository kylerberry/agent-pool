# ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred

**Status:** Accepted — amended 2026-08-13

## Context

ADR-020 makes the routing table role-indexed (one eval class per model-call role). Building all six graders at once is heavy: only R/F self-grades; the rest need known-good references (decomposition, A), planted fixtures (T), or LLM-as-judge (C, S). A pragmatic, dual-use build needs a proof-of-harness before that investment.

## Decision

Build the **builder (R/F) eval row first, and only it, for now**:
- **Self-graded** — tier-1 (test execution) is the oracle; no rubric, no judge, no reference-matching to design.
- **Highest-volume role** — routing-by-cost saves the most here, so best ROI.
- Dataset: tested-ticket seed set (ADR-005). Reps: N=3 (ADR-006). Matrix: Phase-1 Chinese mid-tier (ADR-008). Threshold: empirical (ADR-009).

The builder eval row is post-launch calibration for the direct-task-first deployment. Initial production may use the explicitly approved, qualified, provenance-bearing bootstrap tiers and criteria-fit gate; it must label them provisional and collect real task evidence. Eval-derived winners replace bootstrap routing only after sufficient evidence exists.

The other rows (decomposition, probing, C, A, T) are **explicitly deferred with a known grader approach each** (reference-based, deterministic probe fixtures/downstream usefulness, planted-fixture, or judge), not dropped.

## Consequences

The harness does not block the first direct-task-first deployment. Dogfood and initial production runs generate representative tested work for later calibration while exact qualification, fallback-only provider policy, and bootstrap model-diversity gates remain enforceable.

The harness proves out end-to-end with zero grader-design overhead, on the role where cost-routing matters most. Retroactively removes the tier-2 code_quality/maintainability sub-rubric from the critical path: since the eval currently covers only R/F (tier-1 graded), the maintainability sub-rubric is needed only for the **A phase as a live runtime gate**, which is a separate, later design — not required to ship the eval harness. Deferred rows come online as each grader is built.
