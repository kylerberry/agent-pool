---
title: ADR-014: SQLite for Audit Trail, Not Postgres
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-014-sqlite-audit-trail.md
---

# ADR-014: SQLite for Audit Trail, Not Postgres

## Summary

This ADR records `ADR-014: SQLite for Audit Trail, Not Postgres` for the supervisor orchestrator design.

## Key decisions / claims

SQLite, single file, owned by the orchestrator process. Justified by ADR-001's own architecture: the orchestrator is one deterministic-controller process, so there's exactly one writer — SQLite's classic single-writer limitation never applies here.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-014-sqlite-audit-trail.md`
