---
title: ADR-015: PR Granularity by DAG Connected Component, With Intent
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-015-pr-granularity-by-connected-component.md
---

# ADR-015: PR Granularity by DAG Connected Component, With Intent

## Summary

This ADR records `ADR-015: PR Granularity by DAG Connected Component, With Intent` for the supervisor orchestrator design.

## Key decisions / claims

PR granularity follows the DAG's independent connected components — genuinely unrelated subtrees ship as separate PRs; a single dependency chain stays one PR by necessity but is structured as one commit per node, each carrying its own tier-1/tier-2 scorecard, cost, and model rationale. Every PR includes the originating spec/ticket intent alongside the mechanical diff, not just the changes themselves.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-015-pr-granularity-by-connected-component.md`
