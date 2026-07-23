---
title: ADR-012: Fixed Global Retry Ceiling, Per-Class Override Downward Only
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-012-fixed-global-retry-ceiling.md
---

# ADR-012: Fixed Global Retry Ceiling, Per-Class Override Downward Only

## Summary

This ADR records `ADR-012: Fixed Global Retry Ceiling, Per-Class Override Downward Only` for the supervisor orchestrator design.

## Key decisions / claims

A single global retry ceiling (e.g., 3) applies to every unit by default. Per-task-class overrides are permitted only to lower the ceiling, never raise it — a class can fail faster, never slower.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-012-fixed-global-retry-ceiling.md`
