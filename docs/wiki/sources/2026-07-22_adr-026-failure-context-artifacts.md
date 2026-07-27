---
title: ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md
---

# ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch

## Summary

This ADR records `ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch` for the supervisor orchestrator design.

## Key decisions / claims

Two mechanisms remain: structured failure-context artifacts are the primary machine-consumed record, while retained transcripts are an authorized-human escape hatch. The 2026-07-27 amendment requires retained transcripts to be finalized, redacted, hashed, durably persisted outside the ephemeral workspace, verified, and transactionally indexed before cleanup. The audit index stores durable object and lifecycle metadata rather than a workspace path; extraction failure marks the attempt `audit_incomplete`.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md`
