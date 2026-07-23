---
title: ADR-002: Fuzzy-In / Structured-Out Spec Boundary
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-002-fuzzy-in-structured-out-spec-boundary.md
---

# ADR-002: Fuzzy-In / Structured-Out Spec Boundary

## Summary

This ADR records `ADR-002: Fuzzy-In / Structured-Out Spec Boundary` for the supervisor orchestrator design.

## Key decisions / claims

No prescribed input format. A model-driven decomposition step accepts free-form markdown and normalizes it into a validated DAG schema. The deterministic controller only ever consumes the normalized DAG — never the raw spec.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-002-fuzzy-in-structured-out-spec-boundary.md`
