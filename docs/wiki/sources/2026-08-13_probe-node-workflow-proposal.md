---
title: Probe Node Workflow Proposal
type: source
tags: [source, proposed, dag, crafts, probe]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/plans/probe-node-workflow-proposal.md
---

# Probe Node Workflow Proposal

> ⚠️ Proposed: no `craft-pool`, queue, schema, or controller behavior changes yet.

A probe is ordinary DAG work only when it resolves a shared/decomposition-significant uncertainty. It runs normal CRAFTS, leaves a durable merge-safe repository artifact, and unlocks dependents only after verified mainline integration. A disproved hypothesis fails and follows governed amendment rather than releasing dependent work.

Local disposable experiments remain an optional C.2 activity inside one node. Focused controller-side diagnosis is deliberately deferred.

## Related

- [[wiki/sources/2026-08-13_adr-035-minimal-coherent-dag-nodes|ADR-035: Minimal Coherent DAG Nodes]]
- [[wiki/sources/2026-08-13_adr-036-discovered-work-and-dag-amendment|ADR-036: Discovered Work and DAG Amendment]]
- [[wiki/sources/2026-08-13_adr-038-node-level-mainline-integration|ADR-038: Node-Level Mainline Integration]]
