---
title: Warm Agent Pool
type: product
tags: [agent-pool, github, execution]
created: 2026-07-22
updated: 2026-08-21
sources:
  - docs/raw/specs/orchestrator-spec.md
---

# Warm Agent Pool

The warm agent pool is the DAG-unaware execution substrate: ready capacity slots accept atomic jobs and start a fresh Pool Worker Pi process/session and workspace for every attempt. Slots may persist; conversational state never does. These runtime workers are distinct from Repository Builder sessions developing this codebase.

Pool Proof is complete. `generalize-proven-runner` and `compose-direct-intake-to-execution` of the four-node replacement milestone are complete. Remaining nodes: `general-deterministic-verifier` and `surface-reviewable-output`. The superseded 17-node governance-heavy phase, full free-form supervision, and probing implementation remain post-launch work.

## Key constraints

- Self-hosted low-cost infrastructure target.
- API intake supports specs, direct tasks, and hand-authored DAGs.
- GitHub PRs are the reviewed output surface.
- The orchestrator pins exact role models; Z.ai is cost-prioritized primary and Moonshot is always fallback-only. Workers may use bounded same-attempt fallback while preserving workspace progress and failed-primary cost/evidence.
- Each attempt runs in an isolated workspace/session and credential-free repository sandbox with deterministic runner-owned result handling.

## Relationship to orchestrator

The supervisor orchestrator builds on the pool by dispatching DAG nodes as ordinary atomic tasks. The pool remains intentionally simple: it executes one task at a time without needing global DAG state.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/sources/2026-08-13_functional-pool-deployment|Functional Pool Deployment (superseded)]]
