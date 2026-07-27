# ADR-019: Shared Codebase-RAG Layer Serving Decomposer and C

**Status:** Accepted — refined in part by ADR-022; amended 2026-07-27

> **Note (ADR-022):** This ADR's framing of codebase awareness as a single "RAG layer" is superseded by ADR-022, which splits it into three retrieval modes (grep/LSP for precise code lookup, a code-graph tool for structure/dependency edges, and the LLM-wiki pattern for prose docs) and establishes that vector embeddings are not load-bearing here. The decomposer-vs-C breadth/depth distinction below still stands; only the "one RAG layer" mechanism is revised.

## Context

A spec-only decomposer cannot define "unit of work" honestly — whether a feature is one node or five depends on what already exists in the codebase (existing tables, buses, queues, modules). It also can't see dependency edges between units that share a module. This implies the decomposer needs codebase awareness. But C also relies heavily on codebase context for planning, raising the question of whether decomposer and C are actually the same phase.

## Decision

Introduce a **codebase-RAG layer** (embeddings, vector search, context injection over the target repo) as a **shared retrieval capability** consumed by both the decomposer and C — one pipeline, two consumers, queried at different granularities.

The two phases are adjacent, not identical, distinguished by **breadth vs. depth**:
- **Decomposer** queries *across* units to draw boundaries: "where does this feature cut into independent pieces, and which pieces touch shared surfaces (hidden dependency edges)?" Needs breadth; outputs the set of units and edges; plans none of them.
- **C** queries *within* one unit to plan its build: test strategy, file list, risk, full-vs-lite. Needs depth on its single node; has no view of siblings (the DAG dispatches atomic units).

Codebase awareness serves the decomposer's *boundary-drawing*, not effort estimation (which stays C's, per ADR-018).

At decomposition time, the controller derives **predicted-touch metadata** from the versioned code-graph snapshot: graph units and shared surfaces each proposed node is likely to modify. This is controller-owned scheduling metadata, not model-authored acceptance criteria and not a worker claim. It is frozen with the Gate 1 proposal together with the graph snapshot/version that produced it. The controller uses likely-overlap sets to add scheduling constraints between otherwise-ready nodes without silently changing their approved semantic dependency edges.

## Consequences

The JD's "RAG pipelines for codebase-aware agents" requirement lands where it is load-bearing rather than bolted on. One retrieval layer, not two; no merged mega-phase holding whole-feature carving and per-unit planning in one context (the bloat the decompose-then-dispatch split exists to avoid).

Interaction with ADR-002/003: retrieval makes decomposition output depend on index state — a second non-determinism source alongside the model call. Already covered by ADR-003's human-approved-DAG checkpoint, but that approval now also implicitly approves "the decomposer's read of the codebase was correct," a heavier review than pure structure.

Open empirical risk: if the decomposer in practice needs deep per-unit codebase detail to carve at all, the breadth/depth boundary is too clean and the phases are collapsing. Build them separate over the shared layer and watch whether the decomposer keeps reaching for depth it shouldn't need; merge with evidence if so, not preemptively.

Predicted overlap is advisory scheduling evidence, not proof of semantic conflict. False positives reduce parallelism; false negatives remain protected by integration re-verification. The audit trail therefore records the graph snapshot, predicted overlap, actual touched graph units, serialization decision, and resulting integration contention so thresholds can be calibrated from precision/recall rather than intuition.
