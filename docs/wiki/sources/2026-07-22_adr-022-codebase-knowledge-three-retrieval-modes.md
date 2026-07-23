---
title: ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md
---

# ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer

## Summary

This ADR records `ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer` for the supervisor orchestrator design.

## Key decisions / claims

Three retrieval modes, each matched to a knowledge shape: 1. **Grep / LSP — precise, real-time code lookup (builder / R/F).** When the builder hits an unforeseen problem and needs surrounding code, it needs exact current lookups ("where is this defined, what's the signature, what calls it"). That is grep/LSP/AST territory — exact, no staleness. Semantic RAG is the wrong tool when you know literally what you're looking for. RAG stays out of the R/F path. 2. **Code graph — structure and dependency edges (decomposer; deferred regression_risk).** AST / call-graph / dependency-graph navigation answers "what depends on what" precisely. Load-bearing in two places: the decomposer needs it for hidden dependency edges between units sharing a module (ADR-018/019), and the deferred tier-2 `regression_risk` dimension needs blast-radius ("what imports this"). **Implemented via a pluggable existing too

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md`
