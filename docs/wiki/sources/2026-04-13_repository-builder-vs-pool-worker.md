---
title: Repository Builder and Pool Worker Role Boundary
type: source
tags: [source, agents, harness]
created: 2026-04-13
updated: 2026-08-03
audience: both
subject: development-harness
sources:
  - docs/raw/context/repository-builder-vs-pool-worker.md
---

# Repository Builder and Pool Worker Role Boundary

## Summary

Defines two explicit Pi actors, separates their discovery surfaces, and makes Pool Worker identity dependent on a supervisor-issued execution context and fail-closed preflight.

The Repository Builder uses a local crash-recovery journal—not product-runtime authority. It persists triggered plan-security checkpoints, bounds C/A/T repair loops, requires hash-bound human decisions at exhaustion, preserves retries, upgrades v1 journals through exact-byte backups, and archives rather than mutating runs when an approved plan materially changes. See [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]] for lifecycle details.

## Related pages

- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]
- [[wiki/output/agents-building-agents-handoff|Agents Building Agents Handoff]]

## Raw source

- `docs/raw/context/repository-builder-vs-pool-worker.md`
