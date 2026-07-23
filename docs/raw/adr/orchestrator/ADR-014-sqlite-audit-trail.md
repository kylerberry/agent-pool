# ADR-014: SQLite for Audit Trail, Not Postgres

**Status:** Accepted

## Context

DAG state, per-node results, model decisions, and the cost ledger need durable, queryable storage separate from Redis (which stays owned by the pool's queue, per ADR-001).

## Decision

SQLite, single file, owned by the orchestrator process. Justified by ADR-001's own architecture: the orchestrator is one deterministic-controller process, so there's exactly one writer — SQLite's classic single-writer limitation never applies here.

## Consequences

Minimal infra, trivial backup (file copy), no separate DB service to run or operate. Doesn't scale to multi-tenant concurrent writers or centralized cross-client querying — if that's ever needed, swap to Postgres as a compliance-variant deployment choice (same pattern as agent-pool-spec's existing HIPAA/SOC2 AWS variant), not a redesign of the orchestrator itself.
