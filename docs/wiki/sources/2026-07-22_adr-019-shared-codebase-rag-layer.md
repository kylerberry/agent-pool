---
title: ADR-019: Shared Codebase-RAG Layer Serving Decomposer and C
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md
---

# ADR-019: Shared Codebase-RAG Layer Serving Decomposer and C

## Summary

This ADR records `ADR-019: Shared Codebase-RAG Layer Serving Decomposer and C` for the supervisor orchestrator design.

## Key decisions / claims

Introduce a **codebase-RAG layer** (embeddings, vector search, context injection over the target repo) as a **shared retrieval capability** consumed by both the decomposer and C — one pipeline, two consumers, queried at different granularities. The two phases are adjacent, not identical, distinguished by **breadth vs. depth**: - **Decomposer** queries *across* units to draw boundaries: "where does this feature cut into independent pieces, and which pieces touch shared surfaces (hidden dependency edges)?" Needs breadth; outputs the set of units and edges; plans none of them. - **C** queries *within* one unit to plan its build: test strategy, file list, risk, full-vs-lite. Needs depth on its single node; has no view of siblings (the DAG dispatches atomic units). Codebase awareness serves the decomposer's *boundary-drawing*, not effort estimation (which stays C's, per ADR-018).

The 2026-07-27 amendment adds controller-owned, versioned predicted-touch metadata at Gate 1. Likely overlap may serialize dispatch without changing semantic DAG edges; predicted versus actual touched units and integration contention are retained to calibrate the scheduler.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md`
