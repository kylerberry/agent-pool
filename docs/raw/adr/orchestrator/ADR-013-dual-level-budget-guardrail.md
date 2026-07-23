# ADR-013: Dual-Level Budget Guardrail — Per-Node and Per-DAG

**Status:** Accepted

## Context

Cost guardrails were named as a trust requirement early on but never given concrete enforcement rules.

## Decision

Two independent ceilings.

- **Per-node:** a unit blowing its budget is treated as a retry-ceiling failure — stop, escalate per ADR-011.
- **Per-DAG (aggregate):** hitting it halts further dispatch (no new ready-frontier nodes go out) but lets in-flight nodes finish, then escalates the whole DAG to a human.

## Consequences

A single expensive node is contained at the node level without disrupting the rest of the DAG. A DAG-wide overrun — signaling something systemic like bad decomposition or thrashing retries — surfaces as its own distinct, higher-severity escalation rather than being masked by node-level containment.
