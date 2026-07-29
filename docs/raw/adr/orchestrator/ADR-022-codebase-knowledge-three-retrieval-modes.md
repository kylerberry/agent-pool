# ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer

**Status:** Accepted — amended 2026-07-27
**Refines:** ADR-019 (which framed codebase awareness as a single "RAG layer")

## Context

ADR-019 lumped all codebase awareness under one "RAG layer." On closer design, "how agents know things" is three different problems with three different knowledge shapes, and treating them as one semantic-vector-search layer is a category error. Separately, vector embeddings — a named JD requirement — turn out not to be load-bearing anywhere in this system, which is worth stating honestly rather than manufacturing a use for them.

## Decision

Three retrieval modes, each matched to a knowledge shape:

1. **Grep / LSP — precise, real-time code lookup (builder / R/F).**
   When the builder hits an unforeseen problem and needs surrounding code, it needs exact current lookups ("where is this defined, what's the signature, what calls it"). That is grep/LSP/AST territory — exact, no staleness. Semantic RAG is the wrong tool when you know literally what you're looking for. RAG stays out of the R/F path.

2. **Code graph — structure and dependency edges (decomposer; deferred regression_risk).**
   AST / call-graph / dependency-graph navigation answers "what depends on what" precisely. Load-bearing in two places: the decomposer needs it for hidden dependency edges between units sharing a module (ADR-018/019), and the deferred tier-2 `regression_risk` dimension needs blast-radius ("what imports this"). **Implemented via a pluggable existing tool (tree-sitter / repo-map / LSP-class), not built from scratch.** Not embeddings. Graph data is derived from a target-repository workspace at an identified head and lives in bounded, controller-managed runtime storage keyed by repository identity, head, and tool/index version. It is regenerable cache data, not durable repository knowledge and not an in-memory corpus shared across targets.

3. **Target-repository prose knowledge — repo-native when present; optional when absent.**
   Documentation/domain knowledge is served by a target repository's own instructions, README, documentation indexes, ADRs, wiki, or other approved knowledge store—not by the Agent Pool product repository's `docs/wiki/`. Retrieval follows target-repository indexes and retains source provenance. A wiki accumulates and compounds (pre-compiled, interlinked entity pages); RAG retrieves and forgets (re-derives from raw chunks every query), so a repository-native wiki is a suitable sink where it already exists. Its absence is not a failure: agents fall back to target-repository instructions, ordinary documentation, grep/LSP, and the code graph, while reporting the prose-knowledge capability as unavailable.

   S-phase learnings may write only to a target-repository owner-approved knowledge sink. If no sink is declared, S returns a structured proposal; it must not create a documentation convention automatically. An owner may approve a repository-native bootstrap such as `docs/agent-knowledge/` linked from repository instructions. `.agent-pool/` is reserved for launcher-owned execution context and is not a knowledge sink.

4. **External knowledge providers are deferred and must be controller-approved.**
   A target repository may later declare a read-only MCP or similar knowledge provider, but repository configuration is untrusted input and must never auto-launch a server. Future support requires controller onboarding approval, pinned server/image and version, explicit read-only tool allowlists, scoped secrets and egress, phase grants, and provider/tool/version provenance. A write-capable external sink is a separately approved future capability.

## Consequences

Vector embeddings are consciously absent — the honest interview answer is "I used the LLM-wiki pattern for doc knowledge because it compounds rather than re-derives, and code lookup is better served by graph+grep than embeddings," a defended architectural choice rather than a checked box (same posture as the LangGraph rejection). Caveat retained: vector RAG remains the right tool for a large corpus of *uncompiled, un-greppable* raw docs — this system just doesn't have that shape.

Two known repository-native wiki failure modes are accepted as design obligations where a repository provides or approves one:
- **Hallucination propagation** — compressing sources into wiki pages can bake a misreading in as fact and propagate it across linked pages. Mitigation: the S-phase needs a lint/consistency audit pass (spot-check pages against sources), not blind append.
- **Scale ceiling (~200 files)** — beyond which the agent can't hold the full graph in context. Mitigation: directory-level indexes; flat wiki early, hierarchical indexes as it grows.

The absence of a wiki is a supported state, not a failure mode. The controller does not maintain an unbounded sidecar knowledge corpus as a substitute; it retains only bounded, regenerable derived indexes and audit provenance.

## Related (not part of this ADR)

Within-node context management (context-window discipline across C→R→A→F→T→S) is handled by a **CRAFTS skill rule**, not an orchestrator ADR: each phase passes its structured *output artifact* (plan, findings, verification) forward, never its full working transcript. Compaction falls out of the phase-gate structure rather than a bolted-on summarizer. To be added to the CRAFTS skill(s).
