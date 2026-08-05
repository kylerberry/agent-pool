---
title: Warm Agent Pool
type: product
tags: [agent-pool, github, execution]
created: 2026-07-22
updated: 2026-08-05
sources:
  - docs/raw/specs/orchestrator-spec.md
---

# Warm Agent Pool

The warm agent pool is the DAG-unaware execution substrate: ready capacity slots accept atomic jobs and start a fresh Pool Worker Pi process/session and workspace for every attempt. Slots may persist; conversational state never does. These runtime workers are distinct from Repository Builder sessions developing this codebase.

The current approved Pool Proof first exercises a builder-only Worker Harness profile against a deterministic fixture, with runner-owned verification and no evaluator or CRAFTS phase history. Full CRAFTS, grading, and GitHub delivery remain later v1 work.

## Key constraints

- Self-hosted low-cost infrastructure target.
- API intake supports specs, direct tasks, and hand-authored DAGs.
- GitHub PRs are the reviewed output surface.
- The orchestrator pins role models; workers may use an intra-attempt backend fallback while preserving workspace progress.
- Each attempt runs in an isolated workspace/session and credential-free repository sandbox with deterministic runner-owned result handling.

## Relationship to orchestrator

The supervisor orchestrator builds on the pool by dispatching DAG nodes as ordinary atomic tasks. The pool remains intentionally simple: it executes one task at a time without needing global DAG state.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
