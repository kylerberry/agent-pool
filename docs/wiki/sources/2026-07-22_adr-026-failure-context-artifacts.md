---
title: ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md
---

# ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch

## Summary

This ADR records `ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch` for the supervisor orchestrator design.

## Key decisions / claims

Two mechanisms, primary and escape hatch: 1. **Failure-context artifact section (primary).** A failing phase's emitted artifact MUST include: what was attempted, why it failed, and discoveries made (edge cases, surprising behavior, ruled-out dead ends). Retry attempts receive prior attempts' failure artifacts in their task payload — a retry never starts blind. Still structured, still not a transcript; the discovery survives because it is part of the artifact contract. 2. **Transcript index (escape hatch).** Raw transcripts — already retained on disk per the pool spec as write-once debugging aids — are indexed in the SQLite audit trail by node id + attempt (a `transcript_path` column on the attempt record). Humans (or a future failure-diagnosis step) can look one up directly instead of spelunking the volume. Transcripts are never auto-injected into prompts.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md`
