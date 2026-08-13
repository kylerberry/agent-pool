# ADR-036: Discovered Work Records and Governed DAG Amendment

**Status:** Accepted
**Extends:** ADR-024 (amend-DAG)
**Relates to:** ADR-003 (gated checkpoint), ADR-010 (node-level dispatch), ADR-011 (failed-node containment), ADR-026 (failure context artifacts)

## Context

Implementation can reveal missing prerequisites, unsafe assumptions, adjacent defects, or a boundary that cannot be completed as approved. Without a bounded feedback path, Workers either lose the finding in prose or silently expand their node. ADR-024 permits a human-approved amendment after a bad boundary is known, but does not define the Worker-to-controller discovery record, classification, or audit behavior that supplies that knowledge.

## Decision

A Worker may attest **discovered work** but may not implement, prioritize, enqueue, amend, or dispatch it outside the approved node.

A discovered-work record is bounded, append-only controller evidence linked to its work ID, node ID, attempt ID, and immutable result/failure provenance. It contains only:

- an observed fact and bounded evidence locator or diagnostic;
- affected boundary or paths, when known;
- classification: `adjacent`, `correctness_or_security_blocker`, or `topology_or_scope_change`;
- whether the finding blocks safe completion of the active node; and
- a suggested outcome and dependency relation, explicitly non-authoritative.

It contains no unbounded transcript, credentials, raw provider output, caller-controlled priority, authority to alter acceptance criteria, or executable plan. The controller validates and redacts the record at its result boundary, persists it separately from node lifecycle state, and audits subsequent classification.

The controller classifies a valid record without mutating the approved DAG:

1. **Adjacent and non-blocking:** retain as a backlog candidate; the current DAG and node outcome remain unchanged.
2. **Correctness or security blocker:** fail or mark the active node as needing governed resolution; do not smuggle the work into the attempt.
3. **Topology or scope change:** recommend the human-initiated `amend-DAG` action from ADR-024. The controller may recommend but never automatically amend.

An amendment cancels only the affected unmet subtree, re-decomposes the unmet remainder against the original intent and passed-node context, validates the replacement topology, derives/freeze-binds current predicted-touch metadata, and requires renewed Gate 1 approval. Passed nodes and their evidence remain immutable. New amendment nodes dispatch only after approval.

## Consequences

Findings become durable planning evidence rather than session drift or lost transcript text. The distinction between a blocked approved outcome and adjacent backlog work remains visible. Workers stay bounded and DAG topology remains controller-owned, human-approved, and auditably changed only through ADR-024.

This decision creates a future cross-domain implementation unit: add a bounded Worker result/discovery contract; append-only Orchestration persistence and audit queries; controller classification/escalation integration; and Work Intake amendment input that includes passed-node context. Tests must prove discoveries cannot widen the active attempt, mutate topology, enqueue work, or bypass renewed Gate 1.
