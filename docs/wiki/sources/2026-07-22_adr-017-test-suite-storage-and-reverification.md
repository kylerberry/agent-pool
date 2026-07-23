---
title: ADR-017: Test Suite Storage, Versioning, and Re-Verification at Integration
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-017-test-suite-storage-and-reverification.md
---

# ADR-017: Test Suite Storage, Versioning, and Re-Verification at Integration

## Summary

This ADR records `ADR-017: Test Suite Storage, Versioning, and Re-Verification at Integration` for the supervisor orchestrator design.

## Key decisions / claims

**Storage:** the test suite is written to the repo where it executes; the node record holds the path plus a content hash. Not stored inline in SQLite — it's real code that must live in the tree to run (tier-1 executes it, builder builds against it, it ships in the PR). The hash gives the audit trail (ADR-014) an immutable record of exactly which suite version graded each attempt, even after the repo file changes. **Intra-node versioning:** each revision of the suite during a node's own execution records a new content hash; the audit trail keeps the sequence. Tier-1 grades against the current version. No conflict — one node owns its suite during its turn. **Cross-node contention:** parallel nodes modifying the same test file are governed by the warm pool's existing optimistic-concurrency rule (CI/test suite as merge-time arbiter) — first to integrate wins, second re-derives against the ne

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-017-test-suite-storage-and-reverification.md`
