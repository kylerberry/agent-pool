---
title: ADR-011: Failed Nodes Freeze Their Branch, Not the DAG
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-011-failed-nodes-freeze-branch.md
---

# ADR-011: Failed Nodes Freeze Their Branch, Not the DAG

## Summary

This ADR records `ADR-011: Failed Nodes Freeze Their Branch, Not the DAG` for the supervisor orchestrator design.

## Key decisions / claims

A failed node never enters completed state, so its dependents simply never become ready — they freeze, not cancel. The failed node escalates to a human per the retry-ceiling envelope. Unrelated branches keep executing in parallel, unaffected. Frozen dependents resume once a human resolves the failed node (fix, override, or cancel that branch).

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-011-failed-nodes-freeze-branch.md`
