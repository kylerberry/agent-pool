---
title: Graphify Planning Guidance
type: output
tags: [development-harness, graphify, planning]
created: 2026-08-15
updated: 2026-08-15
sources:
  - AGENTS.md
  - docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md
  - docs/raw/adr/orchestrator/ADR-029-agent-tool-surface-and-phase-scoping.md
---

# Graphify Planning Guidance

Repository Builders may query a current local `graphify-out/graph.json` during early CRAFTS planning and for code-relationship questions. The ignored graph is regenerable structural evidence, so agents must check its health and provenance and verify conclusions against source and tests. `docs/wiki/` and canonical raw artifacts remain the prose and decision layer; generated Graphify wiki output is never canonical.
