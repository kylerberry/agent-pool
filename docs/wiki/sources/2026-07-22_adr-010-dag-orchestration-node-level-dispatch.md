---
title: ADR-010: DAG-Level Orchestration, Node-Level Queue Dispatch
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-010-dag-orchestration-node-level-dispatch.md
---

# ADR-010: DAG-Level Orchestration, Node-Level Queue Dispatch

## Summary

This ADR records `ADR-010: DAG-Level Orchestration, Node-Level Queue Dispatch` for the supervisor orchestrator design.

## Key decisions / claims

One queue ticket = one DAG node, never the whole DAG. Each round, the orchestrator enqueues one self-contained ticket (change spec + acceptance criteria) for every node whose dependencies are complete — the ready frontier — as independent, unrelated-looking jobs. The pool has no knowledge of the DAG; it only ever sees flat atomic units, identical in shape to what it consumes today.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-010-dag-orchestration-node-level-dispatch.md`
