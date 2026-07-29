---
title: ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md
---

# ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer

## Summary

This ADR records `ADR-022: Codebase Knowledge — Three Retrieval Modes, Not One RAG Layer` for the supervisor orchestrator design.

## Key decisions / claims

ADR-022 retains three retrieval modes: direct grep/LSP for precise code lookup, a target-workspace code graph for structural/dependency context, and target-repository prose knowledge when present. Code-graph output is bounded, regenerable controller cache data keyed by target repository, head, and tool/index version; it is not a shared memory corpus.

Target-repository instructions, ordinary docs, ADRs, indexes, and an existing wiki are the prose sources. A wiki is optional: absence falls back to those sources plus grep/LSP and the graph. S may write only to an owner-approved target-repository knowledge sink; otherwise it returns a proposal. Agent Pool's own `docs/wiki/` is never a knowledge store for another target repository, and `.agent-pool/` remains reserved for launcher context.

Read-only external MCP knowledge providers are roadmap work. Repository configuration cannot auto-launch them; controller approval, pinning, least privilege, and provenance are required.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md`
