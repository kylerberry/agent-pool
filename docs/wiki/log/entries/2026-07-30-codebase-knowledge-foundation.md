---
title: Codebase Knowledge Foundation
type: output
tags: [codebase-knowledge, graphify, security]
created: 2026-07-30
updated: 2026-07-30
sources:
  - docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md
  - docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md
  - docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md
  - docs/raw/plans/v1-roadmap.md
---

# Codebase Knowledge Foundation

Implemented target-repository-scoped Graphify indexing through a controller-owned scratch projection, revision-bearing breadth retrieval, bounded regenerable cache data, provenance-bearing documentation discovery, and controller-only predicted-touch evidence. Missing prose knowledge is reported as unavailable; no target knowledge sink, vector store, or repository-declared provider is launched.

The accepted ADR-032 baseline uses path-sensitive exclusion, process hardening, and projection containment. Kyler approved P0 follow-up hardening for content-level secret scanning/redaction, OS default-deny egress, OS read-only mount/sandbox isolation, and reproducible worker-image smoke attestation.

Related: [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]], [[wiki/sources/2026-04-13_v1-roadmap|v1 Roadmap]].
