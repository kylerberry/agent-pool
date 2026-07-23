---
title: ADR-009: Empirical Routing Threshold, Not Hardcoded
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-009-empirical-routing-threshold.md
---

# ADR-009: Empirical Routing Threshold, Not Hardcoded

## Summary

This ADR records `ADR-009: Empirical Routing Threshold, Not Hardcoded` for the supervisor orchestrator design.

## Key decisions / claims

No threshold is fixed in advance. Per-task-class thresholds are derived from the actual Phase 1 score distribution once real runs exist — picked at a natural separation point between tiers, not an arbitrary round number.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-009-empirical-routing-threshold.md`
