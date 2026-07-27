---
title: ADR-032: Practical v1 Worker Isolation Baseline
type: source
tags: [source, orchestrator]
created: 2026-04-13
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md
---

# ADR-032: Practical v1 Worker Isolation Baseline

## Summary

Canonical project decision or contract incorporated into the current supervisor-orchestrator design. Read the raw source for exact requirements and rationale.

The 2026-07-27 amendment makes workspace cleanup depend on durable recording of required artifacts and the transcript-retention result. Transcript extraction failure produces `audit_incomplete` and an operational alert, but cannot retain an untrusted workspace indefinitely.

## Related pages

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md`
