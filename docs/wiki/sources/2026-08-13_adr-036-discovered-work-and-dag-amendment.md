---
title: ADR-036: Discovered Work Records and Governed DAG Amendment
type: source
tags: [source, adr, dag, orchestration, discovery]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-036-discovered-work-and-dag-amendment.md
---

# ADR-036: Discovered Work Records and Governed DAG Amendment

## Summary

Workers may report bounded, provenance-linked discoveries but cannot act beyond their approved node. The controller classifies discoveries as adjacent backlog, correctness/security blockers, or topology/scope changes. Only a human-approved ADR-024 amendment changes the DAG.

## Key decisions

- Discovery records are append-only, bounded, redacted controller evidence—not a plan, priority request, or topology mutation.
- Adjacent non-blockers become backlog candidates; they do not alter current work.
- Blockers enter governed resolution; Workers do not smuggle the work into their attempt.
- Scope/topology discoveries can recommend, but never automatically trigger, `amend-DAG`; amendment preserves passed work and requires renewed Gate 1.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/sources/2026-07-22_adr-024-amend-dag-resolution-action|ADR-024: Amend-DAG]]
