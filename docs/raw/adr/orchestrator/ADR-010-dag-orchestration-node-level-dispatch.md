# ADR-010: DAG-Level Orchestration, Node-Level Queue Dispatch

**Status:** Accepted

## Context

The orchestrator needs a dispatch strategy for pushing DAG work onto the existing queue.

## Decision

One queue ticket = one DAG node, never the whole DAG. Each round, the orchestrator enqueues one self-contained ticket (change spec + acceptance criteria) for every node whose dependencies are complete — the ready frontier — as independent, unrelated-looking jobs. The pool has no knowledge of the DAG; it only ever sees flat atomic units, identical in shape to what it consumes today.

## Consequences

Pool stays completely unchanged (per ADR-001's split — orchestrator stateful, pool stateless). DAG-level structure and node-level execution are fully decoupled, which keeps the queue's contract simple and the orchestrator as the sole place DAG logic lives. Requires the orchestrator to track per-node completion state and recompute the ready frontier after every batch of results.
