---
title: ADR-007: Provider-Agnostic Model Interface
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-007-provider-agnostic-model-interface.md
---

# ADR-007: Provider-Agnostic Model Interface

## Summary

This ADR records `ADR-007: Provider-Agnostic Model Interface` for the supervisor orchestrator design.

## Key decisions / claims

All model calls go through a thin per-provider adapter normalized to one input/output contract. Providers are interchangeable configuration, not architecture — the orchestrator and routing table have no provider-specific logic.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-007-provider-agnostic-model-interface.md`
