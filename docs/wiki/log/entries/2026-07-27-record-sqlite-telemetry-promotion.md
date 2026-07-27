---
title: Record SQLite Telemetry Promotion Candidate
type: operation
tags: [telemetry, evaluation, sqlite, roadmap]
created: 2026-07-27
updated: 2026-07-27
sources:
  - docs/raw/plans/v1-roadmap.md
  - docs/raw/adr/orchestrator/ADR-014-sqlite-audit-trail.md
---

# Record SQLite Telemetry Promotion Candidate

Added a fast-follow roadmap candidate to retain local eval JSONL/manifests as an inspectable crash-recovery spool while transactionally ingesting normalized telemetry into the orchestrator-owned SQLite audit store. Sanitized eval-candidate JSON remains a portable derived artifact.

The candidate calls for unique event identities, idempotent ingestion, schema migrations, integrity checks, retention and WAL-safe backup policy, and explicit promotion state between operational telemetry and formal evaluation evidence.
