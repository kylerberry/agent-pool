---
title: ADR-039: Agent-Assisted Probe Execution Outside CRAFTS
type: source
tags: [source, adr, probe, routing, evidence]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-039-agent-assisted-probe-execution.md
---

# ADR-039: Agent-Assisted Probe Execution Outside CRAFTS

## Summary

A probe is a one-call bounded Worker profile for mocking boundaries, discovering unknowns, and leaving durable evidence that constrains later CRAFTS sessions. It is neither full/lite CRAFTS nor a controller authority.

## Decisions

- One fresh Worker and one `probing` call.
- GLM-5.3 primary; Kimi K3 fallback.
- Strict hypothesis/evidence input and output contracts.
- Deterministic validation; no self-grading, dispatch, routing, or topology mutation.
- Supported evidence may unlock approved dependents after integration; disproved evidence blocks and recommends amendment; inconclusive evidence fails.
- Future C must consume the artifact, acknowledge settled uncertainty, and avoid recorded dead ends.
- Implementation is post-launch, outside the 17-node deployment path.

## Related

- [[wiki/sources/2026-08-13_probe-node-workflow-proposal|Agent-Assisted Probe Workflow]]
- [[wiki/sources/2026-07-22_adr-020-role-indexed-routing-table|ADR-020: Role-Indexed Routing]]
- [[wiki/sources/2026-08-13_adr-036-discovered-work-and-dag-amendment|ADR-036: Discovered Work and Amendment]]
