---
title: Target-Repository Knowledge Policy and External Provider Roadmap
type: log
tags: [knowledge, target-repository, mcp, roadmap]
created: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md
  - docs/raw/adr/orchestrator/ADR-029-agent-tool-surface-and-phase-scoping.md
  - docs/raw/plans/v1-roadmap.md
---

# Target-Repository Knowledge Policy and External Provider Roadmap

Amended ADR-022 and ADR-029 to make knowledge target-repository scoped. Derived code graphs are bounded, regenerable controller cache data keyed by target repository, head, and tool/index version; they are not a shared sidecar corpus. Target-repository docs, instructions, ADRs, indexes, and an existing wiki are optional prose sources. When no approved knowledge sink exists, S returns a proposal rather than creating a convention; `.agent-pool/` remains reserved for launcher context.

Recorded a fast-follow MCP/external-provider track: repository configuration is untrusted and cannot auto-launch a server. Future support requires controller onboarding approval, pinned versions, read-only allowlists, scoped secrets/egress, phase grants, and provider/tool/version provenance. External write sinks remain separately deferred.
