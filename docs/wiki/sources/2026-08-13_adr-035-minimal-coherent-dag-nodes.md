---
title: ADR-035: Minimal Coherent DAG Nodes
type: source
tags: [source, adr, dag, decomposition, scope]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-035-minimal-coherent-dag-nodes.md
---

# ADR-035: Minimal Coherent DAG Nodes

## Summary

A DAG node is the smallest independently verifiable vertical slice that preserves correctness—not the smallest code edit. Each proposed node has one observable outcome, primary invariant/oracle, bounded seam, explicit non-goals, and only genuine dependencies.

## Key decisions

- Split independently acceptable outcomes and unrelated cleanup, refactoring, documentation, or follow-on capability work.
- Permit cross-domain/contract/suite work only where inseparable for one outcome; require a concise scope rationale at Gate 1.
- Preserve ADR-018’s exact five emitted fields. Non-goals and scope rationale are proposal-review metadata, never Worker payload or runtime state.
- A Worker cannot broaden an approved node; use [[wiki/sources/2026-08-13_adr-036-discovered-work-and-dag-amendment|discovered-work records]] for new findings.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/sources/2026-07-22_adr-018-decomposition-emission-schema|ADR-018: Decomposition Emission Schema]]
