---
title: ADR-006: N=3 Reliability Reps Per Task
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-006-n3-reliability-reps.md
---

# ADR-006: N=3 Reliability Reps Per Task

## Summary

This ADR records `ADR-006: N=3 Reliability Reps Per Task` for the supervisor orchestrator design.

## Key decisions / claims

Each task × model runs 3 times at Phase 1. Raise to 5+ later only for task classes showing inconsistent results.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-006-n3-reliability-reps.md`
