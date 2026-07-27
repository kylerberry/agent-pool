# ADR-023: Failure-Class Retry Counters — Logic vs. Integration

**Status:** Accepted — amended 2026-07-27
**Amends:** ADR-012 (fixed global retry ceiling)

## Context

Adversarial review surfaced a livelock/miscount risk in optimistic concurrency: parallel nodes sharing surfaces (e.g. a core types file) can repeatedly invalidate each other at integration. Under ADR-012, each re-derivation counted against the same retry ceiling as a logic failure — a healthy node could exhaust its retries and escalate purely for losing integration races, never for a defect of its own. Budget and ceiling would burn on merge churn rather than real failures.

## Decision

Attempt failures are **classified** and counted separately:

- **`logic` failure** — the node's own defect: tier-1 red on its own suite, tier-2 below threshold, build error. Counts against the ADR-012 retry ceiling (default 3).
- **`integration` failure** — a previously-passed node re-fails tier-1 at re-verification (ADR-017) because a sibling's integration changed the head/suite underneath it. Counts against a **separate integration ceiling** (default 3, same downward-only override rule).

Either ceiling exhausting escalates the node, but the escalation record names the class — a human triaging sees "lost 3 integration races" (a contention/decomposition signal) vs. "failed its own tests 3 times" (a defect signal), which imply different resolutions.

The existing mitigations remain the first line: controller-owned predicted-touch metadata from the decomposition-time code graph (ADR-019/022) serializes likely shared surfaces before dispatch; re-verification (ADR-017) remains the final arbiter for semantic merge breakage. Scheduling serialization does not create or rewrite semantic DAG dependencies.

For every prediction, the audit trail records predicted graph units, actual touched graph units, whether dispatch was serialized, and whether an integration-class failure occurred. Thresholds for serialization are empirical and versioned. A stale/missing graph or low-confidence prediction falls back to optimistic concurrency rather than pretending certainty.

## Consequences

Nodes are no longer punished as defective for contention they didn't cause; livelock stays bounded (the integration ceiling still terminates the loop, escalating with the right diagnosis). Cost: one classification per failed attempt — cheap, since the audit trail already records why each attempt failed. Repeated actual integration failures across a DAG, or sustained measured prediction misses above a configured threshold, produce an amend-DAG **recommendation** (ADR-024). Predictions alone never mutate topology or trigger amendment automatically.
