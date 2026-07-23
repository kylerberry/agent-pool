---
title: ADR-004: Tiered Grading, Not Tests-as-Sole-Grader
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-004-tiered-grading-not-tests-as-sole-grader.md
---

# ADR-004: Tiered Grading, Not Tests-as-Sole-Grader

## Summary

This ADR records `ADR-004: Tiered Grading, Not Tests-as-Sole-Grader` for the supervisor orchestrator design.

## Key decisions / claims

Two-tier grading. - **Tier 1 (deterministic, blocking):** tests, lint, typecheck, static/security analysis, coverage delta — binary pass/fail, necessary but not sufficient. - **Tier 2 (model-judged):** a second model scores acceptance-criteria fit, code quality, regression risk outside coverage, and usability — a rubric score, not pass/fail. Composite of both feeds the HITL gate and the eval harness's routing table.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-004-tiered-grading-not-tests-as-sole-grader.md`
