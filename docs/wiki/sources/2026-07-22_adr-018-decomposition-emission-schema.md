---
title: ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md
---

# ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split

## Summary

This ADR records `ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split` for the supervisor orchestrator design.

## Key decisions / claims

The DAG is a **flat list of nodes**, each carrying a `depends_on: [nodeId]` array — not a nested tree. A DAG allows convergence (a node with multiple parents), which a tree cannot represent without duplication; a flat edge list is the honest encoding and is mechanically validatable (all referenced ids exist; no cycles) before dispatch. **Per-node fields the decomposer emits:** `id`, `intent`, `change_spec`, `acceptance_criteria`, `depends_on`. **Explicitly not emitted:** - Runtime state (`status`, `retry_count`, `budget_spent`, test-suite `path`/`hash`) — the controller initializes and owns these. Decomposer emits the *plan*; controller owns the *state*. - `required_role` — meaningless in the supervisor build, where every node runs the full CRAFTS methodology internally (role only exists *inside* CRAFTS, where the sequence is fixed). It's a swarm-build property (agents self-select by rol

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md`
