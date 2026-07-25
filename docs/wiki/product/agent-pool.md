---
title: Warm Agent Pool
type: product
tags: [agent-pool, github, execution]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/specs/orchestrator-spec.md
---

# Warm Agent Pool

The warm agent pool is the DAG-unaware execution substrate: fresh Pool Worker Pi sessions accept atomic node jobs, load `packages/worker-harness/`, run CRAFTS, commit and report graded results, and leave GitHub PR delivery to the supervisor. These runtime workers are distinct from Repository Builder sessions developing this codebase.

## Key constraints

- Self-hosted low-cost infrastructure target.
- API intake supports specs, direct tasks, and hand-authored DAGs.
- GitHub PRs are the reviewed output surface.
- The orchestrator pins role models; workers may use an intra-attempt backend fallback while preserving workspace progress.
- Each attempt runs in an isolated workspace with idempotent result handling.

## Relationship to orchestrator

The supervisor orchestrator builds on the pool by dispatching DAG nodes as ordinary atomic tasks. The pool remains intentionally simple: it executes one task at a time without needing global DAG state.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
