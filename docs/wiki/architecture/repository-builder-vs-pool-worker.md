---
title: Repository Builder vs Pool Worker
type: architecture
tags: [agents, pi, harness, runtime]
created: 2026-04-13
updated: 2026-08-20
audience: both
subject: development-harness
sources:
  - docs/raw/context/repository-builder-vs-pool-worker.md
---

# Repository Builder vs Pool Worker

This project has two Pi actors:

- **Repository Builder** — a local development session that builds the product from repository instructions and approved constraints. It is the default without verified Pool Worker context.
- **Pool Worker** — a fresh runtime session executing one attempt through an explicitly selected `packages/worker-harness` profile. The approved Pool Proof uses a builder-only profile; full `craft-pool`/`craft-*` execution remains deferred.

A Repository Builder does not execute a production DAG node or invoke `craft-pool`. The Minimal
Pool Runtime and Harness are deterministic software, not Pi actors. Product subject matter never
determines actor identity.

## Enforcement

- Runtime-only agents and skills live under `packages/worker-harness/` and are loaded explicitly for Pool Worker sessions.
- Trusted product-runtime code sets actor and independent identity/target/runtime expectations, then supplies launcher-owned context per attempt; preflight requires them to match and rejects stale or replayed contexts.
- Pool Proof explicitly loads one builder-only profile with private Pi config/session roots and workspace-confined sandbox tools. The later full profile retains its separate CRAFTS, model-diversity, Graphify, and artifact checks.
- `actor_identity` exposes sanitized launcher-captured identity for introspection, but capabilities and result acceptance—not model prose—enforce the boundary.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/output/agents-building-agents-handoff|Agents Building Agents Handoff]]

## Raw source

- `docs/raw/context/repository-builder-vs-pool-worker.md`
