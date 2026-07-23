# ADR-027: Spec Intake as an API, Not a Form; Asynchronous Decomposition

**Status:** Accepted
**Relates to:** ADR-002 (fuzzy-in/structured-out), ADR-003 (Gate 1), ADR-010 (node dispatch), ADR-024 (amend-DAG)

## Context

Spec intake was never specified, and an implementation assumption drifted toward form entry. That is the wrong shape: the human touchpoint in this pipeline is **Gate 1 approval**, not submission. Submission is a machine interface. Additionally, decomposition is a model call plus retrieval — it cannot complete inside a request/response cycle, so intake is necessarily asynchronous.

## Decision

**Intake is an HTTP API.** `POST /specs` accepts raw markdown plus target repo/branch and an optional idempotency key; auth reuses the pool's bearer-token scheme. No schema is imposed on the markdown (ADR-002: fuzzy in, structured out). The endpoint enqueues a decomposition job and returns `202 {spec_id, status: "decomposing"}` immediately.

Lifecycle:

```
POST /specs                -> 202 {spec_id, status: "decomposing"}
  -> decomposition job     (model call + code-graph retrieval)
  -> schema validation     (ids, cycles, referential integrity)
  -> DAG persisted         status: "awaiting_approval"     <- GATE 1
POST /specs/{id}/approve   -> controller begins the dispatch loop
  -> ready frontier enqueued to the node queue, one job per node
```

Supporting endpoints: `GET /specs/{id}` (status + DAG for review), `POST /specs/{id}/approve` (Gate 1), `POST /specs/{id}/amend` (ADR-024 partial re-decomposition). The CLI and any dashboard are **clients of these endpoints**, not separate surfaces.

**Two sub-decisions:**

1. **Decomposition rides a separate orchestrator queue**, not the node queue — same Redis, distinct contract. ADR-010 defines a node-queue job as exactly one DAG node consumed by a DAG-unaware worker; decomposition is neither one node nor DAG-unaware. Keeping them separate preserves the node worker's clean job schema.

2. **Idempotency is client-supplied.** An `Idempotency-Key` header is stored on the spec record; a replayed request returns the original `spec_id` rather than decomposing again. Prevents a network stutter or curl retry from burning a duplicate model call and producing a second DAG for the same spec.

## Consequences

The system is driveable by anything that can issue an HTTP request — GitHub webhook, cron, another agent, a shell alias — rather than being implicitly human-initiated, which the form assumption would have silently enforced. Human involvement is concentrated where the design always intended it: approving the DAG (Gate 1) and reviewing the PR (Gate 2). Cost: intake is inherently async, so clients must poll `GET /specs/{id}` or wait for the approval prompt — acceptable, since a synchronous decomposition endpoint was never possible anyway.
