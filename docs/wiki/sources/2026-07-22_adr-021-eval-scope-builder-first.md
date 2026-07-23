---
title: ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md
---

# ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred

## Summary

This ADR records `ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred` for the supervisor orchestrator design.

## Key decisions / claims

Build the **builder (R/F) eval row first, and only it, for now**: - **Self-graded** — tier-1 (test execution) is the oracle; no rubric, no judge, no reference-matching to design. - **Highest-volume role** — routing-by-cost saves the most here, so best ROI. - Dataset: tested-ticket seed set (ADR-005). Reps: N=3 (ADR-006). Matrix: Phase-1 Chinese mid-tier (ADR-008). Threshold: empirical (ADR-009). The other rows (decomposition, C, A, T) are **explicitly deferred with a known grader approach each** (reference-based, planted-fixture, or judge), not dropped.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md`
