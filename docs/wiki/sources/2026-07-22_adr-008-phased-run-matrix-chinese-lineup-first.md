---
title: ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-008-phased-run-matrix-chinese-lineup-first.md
---

# ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First

## Summary

This ADR records `ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First` for the supervisor orchestrator design.

## Key decisions / claims

The eval rollout remains Chinese-provider-first, but exact model IDs are versioned run inputs rather than frozen historical examples. The direct-task deployment first qualifies `zai/glm-5.2` and `zai/glm-5.3`. Moonshot remains measurable in eval but fallback-only in production and cannot become primary.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-008-phased-run-matrix-chinese-lineup-first.md`
