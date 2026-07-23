# ADR-003: DAG as Gated Checkpoint

**Status:** Accepted

## Context

Decomposition (ADR-002) is the one non-deterministic step in the pipeline. Left unchecked, a re-run could silently produce a different DAG from the same spec.

## Decision

Persist the decomposition output and require human approval before dispatch to the queue. Re-runs and retries resume from the approved DAG, not from a fresh decomposition call.

## Consequences

Quarantines the pipeline's only non-determinism to a single, auditable, human-gated step; everything downstream is reproducible from that point. Also satisfies the HITL requirement early in the flow rather than only at the end.

Cost: adds a manual approval step before any work dispatches — acceptable latency for the trust guarantee it buys.
