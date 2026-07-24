# ADR-031: Practical v1 Delivery Idempotency; Stronger Cross-Store Atomicity Deferred

**Status:** Accepted
**Relates to:** ADR-010, ADR-014, ADR-023, ADR-027

## Context

BullMQ delivery is at-least-once and controller state lives in SQLite. Full transactional outbox/inbox and distributed fencing would be robust but disproportionate for the initial single-host, single-controller personal deployment. Doing nothing is unsafe: retries or crashes can duplicate paid attempts and GitHub effects.

## Decision

v1 requires the practical minimum:

- stable `spec_id`, `node_id`, and controller-generated `attempt_id` on every job and result;
- unique SQLite constraints that make attempt creation and result acceptance idempotent;
- compare-and-set node transitions using a state version;
- deterministic BullMQ job IDs derived from the attempt ID;
- idempotent Git branch/commit/result handling;
- worker leases/heartbeats and startup reconciliation of SQLite attempts against Redis jobs;
- intake idempotency scoped to caller and route, with payload-hash conflict rejection.

The controller may enqueue after committing SQLite state; reconciliation repairs a missing job. Duplicate jobs/results become no-ops with audit entries.

## Consequences

This prevents ordinary duplicate delivery and crash-stranding without introducing a distributed transaction mechanism. A transactional outbox/inbox, stronger fencing, and formal fault-injection campaign remain fast-follow hardening items.
