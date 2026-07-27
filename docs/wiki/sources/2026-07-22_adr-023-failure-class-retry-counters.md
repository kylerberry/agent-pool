---
title: ADR-023: Failure-Class Retry Counters — Logic vs. Integration
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-023-failure-class-retry-counters.md
---

# ADR-023: Failure-Class Retry Counters — Logic vs. Integration

## Summary

This ADR records `ADR-023: Failure-Class Retry Counters — Logic vs. Integration` for the supervisor orchestrator design.

## Key decisions / claims

Attempt failures are **classified** and counted separately: - **`logic` failure** — the node's own defect: tier-1 red on its own suite, tier-2 below threshold, build error. Counts against the ADR-012 retry ceiling (default 3). - **`integration` failure** — a previously-passed node re-fails tier-1 at re-verification (ADR-017) because a sibling's integration changed the head/suite underneath it. Counts against a **separate integration ceiling** (default 3, same downward-only override rule). Either ceiling exhausting escalates the node, but the escalation record names the class — a human triaging sees "lost 3 integration races" (a contention/decomposition signal) vs. "failed its own tests 3 times" (a defect signal), which imply different resolutions. The existing mitigations remain the first line: the decomposer's graph-informed edges (ADR-019/022) serialize known shared surfaces as depende

The 2026-07-27 amendment makes predicted-touch scheduling the early contention detector while retaining integration re-verification as the final arbiter. Repeated actual contention or sustained prediction misses can recommend amend-DAG, but predictions cannot mutate topology.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-023-failure-class-retry-counters.md`
