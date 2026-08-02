---
title: Local Goal Ledger Repair
type: output
tags: [repository-builder, goal, crafts, ledger]
created: 2026-08-01
updated: 2026-08-01
sources:
  - docs/raw/context/repository-builder-vs-pool-worker.md
---

# Local Goal Ledger Repair

Clarified that project-local `/goal` and `.pi/scripts/goal-dispatcher.mjs` are strict Repository Builder development bookkeeping, not Pool Worker or product-runtime authority.

Fixed local phase progression so `T needs_fix` preserves its artifact, routes to F, records an immutable T recheck revision, and blocks S until latest T passes. Added explicit approver-attributed retry of failed/escalated local attempts while preserving prior completion evidence.

Related: [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]].
