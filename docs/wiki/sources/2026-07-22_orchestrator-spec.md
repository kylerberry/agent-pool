---
title: Supervisor Orchestrator — Consolidated Specification
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-08-13
sources:
  - docs/raw/specs/orchestrator-spec.md
---

# Supervisor Orchestrator — Consolidated Specification

## Summary

The consolidated specification is updated through ADR-039. Pool Proof is complete; the next proposed phase is a nine-node direct-task-first deployment. Model policy uses exact qualified Z.ai primaries, Moonshot fallback-only, tie-capable bootstrap tiers, and post-launch eval calibration. Agent-assisted probes are one-call evidence work outside CRAFTS and remain post-launch.

---

## Key decisions / claims

1. Purpose; 2. System Overview; 3. Architecture Layers; 4. The DAG; 5. Intra-Node Execution — CRAFTS (craft-pool skill); 6. Grading (ADR-004); 7. Test Suites, Merge Arbitration, Re-Verification (ADR-017); 8. PR Assembly & the Revision Loop (ADR-015)

## Related pages

- [[wiki/product/agent-pool|Warm Agent Pool]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/specs/orchestrator-spec.md`
