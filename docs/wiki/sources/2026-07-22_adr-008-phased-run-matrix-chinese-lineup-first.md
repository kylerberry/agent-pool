---
title: ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-008-phased-run-matrix-chinese-lineup-first.md
---

# ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First

## Summary

This ADR records `ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First` for the supervisor orchestrator design.

## Key decisions / claims

- **Phase 1:** mid-tier only from Moonshot, Z.ai, Qwen (3 models) — chosen on cost and reasoning/coding benchmark strength (e.g. GLM-4.7 at 73.8% SWE-bench Verified, $0.60/$2.20), not as a placeholder. - **Phase 2:** expand to full 3×3 Chinese-provider matrix. - **Phase 3:** add Anthropic/OpenAI/Google.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-008-phased-run-matrix-chinese-lineup-first.md`
