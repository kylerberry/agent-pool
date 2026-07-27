---
title: Amend Contention and Transcript Durability ADRs
type: architecture
tags: [orchestration, contention, transcripts, durability, audit]
created: 2026-07-27
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md
  - docs/raw/adr/orchestrator/ADR-023-failure-class-retry-counters.md
  - docs/raw/adr/orchestrator/ADR-024-amend-dag-resolution-action.md
  - docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md
  - docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md
---

# Amend Contention and Transcript Durability ADRs

Amended the orchestration decisions to detect likely cross-node contention before dispatch using controller-owned, versioned predicted-touch metadata from the code graph. Scheduling constraints do not rewrite semantic DAG dependencies; integration re-verification remains the final arbiter. Measured contention can recommend amend-DAG, but amendment remains human-initiated and Gate 1 approved.

Also closed the conflict between transcript indexing and ephemeral workspace destruction. Retained transcripts must be finalized, redacted, hashed, durably persisted, verified, and indexed before cleanup. Failed extraction produces an explicit `audit_incomplete` record without permitting indefinite retention of an untrusted workspace.
