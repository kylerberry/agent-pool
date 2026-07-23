---
title: ADR-001: Deterministic Controller vs. Agentic Orchestrator
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-001-deterministic-controller-vs-agentic-orchestrator.md
---

# ADR-001: Deterministic Controller vs. Agentic Orchestrator

## Summary

This ADR records `ADR-001: Deterministic Controller vs. Agentic Orchestrator` for the supervisor orchestrator design.

## Key decisions / claims

Deterministic controller. Control flow — sequencing, retry ceilings, budget enforcement, escalation triggers, PR assembly — lives in code. Models are invoked only at named checkpoints (decomposition, review adjudication, failure diagnosis) and their output feeds back into the deterministic flow.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-001-deterministic-controller-vs-agentic-orchestrator.md`
