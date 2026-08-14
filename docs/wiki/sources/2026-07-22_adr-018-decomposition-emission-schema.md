---
title: ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md
---

# ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split

## Summary

This ADR records `ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split` for the supervisor orchestrator design.

## Key decisions / claims

The decomposer emits exactly five fields: `id`, `intent`, `change_spec`, `acceptance_criteria`, and `depends_on`. Runtime state, complexity, and execution profile remain controller-owned. Normal implementation nodes run CRAFTS; an explicitly approved ADR-039 probe may use a controller-tagged one-call profile without adding a sixth emitted field. The model cannot self-select that cheaper execution path.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md`
