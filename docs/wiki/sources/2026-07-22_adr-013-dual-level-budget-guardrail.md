---
title: ADR-013: Dual-Level Budget Guardrail — Per-Node and Per-DAG
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-013-dual-level-budget-guardrail.md
---

# ADR-013: Dual-Level Budget Guardrail — Per-Node and Per-DAG

## Summary

This ADR records `ADR-013: Dual-Level Budget Guardrail — Per-Node and Per-DAG` for the supervisor orchestrator design.

## Key decisions / claims

Two independent ceilings. - **Per-node:** a unit blowing its budget is treated as a retry-ceiling failure — stop, escalate per ADR-011. - **Per-DAG (aggregate):** hitting it halts further dispatch (no new ready-frontier nodes go out) but lets in-flight nodes finish, then escalates the whole DAG to a human.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-013-dual-level-budget-guardrail.md`
