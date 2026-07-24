# ADR-014: SQLite for Audit Trail, Not Postgres

**Status:** Accepted

## Context

DAG state, per-node results, model decisions, and the cost ledger need durable, queryable storage separate from Redis (which stays owned by the pool's queue, per ADR-001).

## Decision

SQLite, single file, owned by the orchestrator process. Justified by ADR-001's own architecture: the orchestrator is one deterministic-controller process, so there's exactly one writer — SQLite's classic single-writer limitation never applies here.

## Consequences

Minimal infrastructure and no separate database service to operate. It does not scale to multi-tenant concurrent writers or centralized cross-client querying; if needed later, swap to Postgres as a deployment variant rather than redesigning the orchestrator. Backups must use the WAL-safe process defined by ADR-033, not an unsafe live file copy.
