---
title: ADR-003: DAG as Gated Checkpoint
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-003-dag-as-gated-checkpoint.md
---

# ADR-003: DAG as Gated Checkpoint

## Summary

This ADR records `ADR-003: DAG as Gated Checkpoint` for the supervisor orchestrator design.

## Key decisions / claims

Persist the decomposition output and require human approval before dispatch to the queue. Re-runs and retries resume from the approved DAG, not from a fresh decomposition call.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-003-dag-as-gated-checkpoint.md`
