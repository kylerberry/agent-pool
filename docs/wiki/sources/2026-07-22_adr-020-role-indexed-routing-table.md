---
title: ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md
---

# ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role

## Summary

This ADR records `ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role` for the supervisor orchestrator design.

## Key decisions / claims

The routing table is **role-indexed**: every CRAFTS phase that is a model call is its own routing decision, with its own eval task class and its own "best perf/cost model" derived from that class. A model strong at building may be mediocre at decomposition — different rows, different winners. Rows (one per model-call role): - **Decomposition** — spec → DAG. Graded against known-good decompositions (boundaries + edges). - **Planning (C)** — criteria → test strategy + plan. Graded by reference/judge. - **Building (R/F)** — plan → passing code. Graded by tier-1 pass rate + cost. Self-grading (tests are the oracle). - **Assessing (A)** — diff → catches real defects. Graded against known-defect fixtures. - **Tightening (T)** — security review. Graded against planted vulnerabilities. - **Sharpening (S)** — docs. Lowest-stakes; likely no dedicated eval.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md`
