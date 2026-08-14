---
title: ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md
---

# ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred

## Summary

This ADR records `ADR-021: Eval Harness Scope — Builder (R/F) First, Other Roles Deferred` for the supervisor orchestrator design.

## Key decisions / claims

Build the builder R/F eval row first because Tier 1 is its oracle and it has the highest routing-cost impact. It is now post-launch calibration: the initial direct-task deployment may use exact qualified, explicitly provisional bootstrap tiers. Dogfood/production evidence seeds later calibration. Decomposition, probing, C, A, and T retain separate future grader approaches.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md`
