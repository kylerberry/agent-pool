# ADR-033: Practical v1 Single-Host Operations Baseline

**Status:** Accepted
**Relates to:** ADR-013, ADR-014

## Context

The personal v1 deployment does not need enterprise SLOs or a full observability stack, but a single host must not fail silently or lose its only audit database without a recovery path.

## Decision

v1 requires:

- service health/readiness checks and restart policies;
- structured logs correlated by spec, node, and attempt IDs;
- visible health for queue age, stalled jobs, disk capacity, provider failures, and accumulated cost;
- WAL-safe SQLite backups plus Redis/session backup as applicable, encrypted and copied off-host;
- a documented, periodically exercised restore procedure;
- versioned database migrations with pre-migration backup and rollback guidance;
- bounded log, transcript, artifact, and workspace retention.

No numeric uptime SLO, formal on-call system, or dedicated metrics platform is required for v1.

## Consequences

The deployment gets a credible recovery and diagnosis path without enterprise operational machinery. Formal RPO/RTO, automated alert routing, replicated state, dashboards, and chaos/fault-injection testing are fast-follow items.
