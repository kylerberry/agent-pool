---
title: ADR-005: Ticket-Sourced Eval Dataset, Tested-Only
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-005-ticket-sourced-eval-dataset-tested-only.md
---

# ADR-005: Ticket-Sourced Eval Dataset, Tested-Only

## Summary

This ADR records `ADR-005: Ticket-Sourced Eval Dataset, Tested-Only` for the supervisor orchestrator design.

## Key decisions / claims

Seed set = any ticket from either codebase that already has a test. No retrofitting untested history. Dataset grows forward as new subba tickets are written with acceptance tests as standard practice.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-005-ticket-sourced-eval-dataset-tested-only.md`
