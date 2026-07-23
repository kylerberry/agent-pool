# ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer

**Status:** Accepted
**Refines:** ADR-019 (which framed codebase awareness as a single "RAG layer")

## Context

ADR-019 lumped all codebase awareness under one "RAG layer." On closer design, "how agents know things" is three different problems with three different knowledge shapes, and treating them as one semantic-vector-search layer is a category error. Separately, vector embeddings — a named JD requirement — turn out not to be load-bearing anywhere in this system, which is worth stating honestly rather than manufacturing a use for them.

## Decision

Three retrieval modes, each matched to a knowledge shape:

1. **Grep / LSP — precise, real-time code lookup (builder / R/F).**
   When the builder hits an unforeseen problem and needs surrounding code, it needs exact current lookups ("where is this defined, what's the signature, what calls it"). That is grep/LSP/AST territory — exact, no staleness. Semantic RAG is the wrong tool when you know literally what you're looking for. RAG stays out of the R/F path.

2. **Code graph — structure and dependency edges (decomposer; deferred regression_risk).**
   AST / call-graph / dependency-graph navigation answers "what depends on what" precisely. Load-bearing in two places: the decomposer needs it for hidden dependency edges between units sharing a module (ADR-018/019), and the deferred tier-2 `regression_risk` dimension needs blast-radius ("what imports this"). **Implemented via a pluggable existing tool (tree-sitter / repo-map / LSP-class), not built from scratch.** Not embeddings.

3. **LLM wiki — compounding prose knowledge (S-phase authored).**
   Documentation/domain knowledge is served by the LLM-wiki pattern, not vector RAG. A wiki accumulates and compounds (pre-compiled, interlinked entity pages); RAG retrieves and forgets (re-derives from raw chunks every query). The CRAFTS S-phase already *does* the compile step — writing synthesized learnings, gotchas, and conventions back as durable docs — so the wiki is the natural substrate; retrieval is mostly link/index navigation, not semantic similarity.

## Consequences

Vector embeddings are consciously absent — the honest interview answer is "I used the LLM-wiki pattern for doc knowledge because it compounds rather than re-derives, and code lookup is better served by graph+grep than embeddings," a defended architectural choice rather than a checked box (same posture as the LangGraph rejection). Caveat retained: vector RAG remains the right tool for a large corpus of *uncompiled, un-greppable* raw docs — this system just doesn't have that shape.

Two known LLM-wiki failure modes are accepted as design obligations:
- **Hallucination propagation** — compressing sources into wiki pages can bake a misreading in as fact and propagate it across linked pages. Mitigation: the S-phase needs a lint/consistency audit pass (spot-check pages against sources), not blind append.
- **Scale ceiling (~200 files)** — beyond which the agent can't hold the full graph in context. Mitigation: directory-level indexes; flat wiki early, hierarchical indexes as it grows.

## Related (not part of this ADR)

Within-node context management (context-window discipline across C→R→A→F→T→S) is handled by a **CRAFTS skill rule**, not an orchestrator ADR: each phase passes its structured *output artifact* (plan, findings, verification) forward, never its full working transcript. Compaction falls out of the phase-gate structure rather than a bolted-on summarizer. To be added to the CRAFTS skill(s).
