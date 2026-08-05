---
title: Repository Builder vs Pool Worker
type: architecture
tags: [agents, pi, harness, runtime]
created: 2026-04-13
updated: 2026-08-05
audience: both
subject: development-harness
sources:
  - docs/raw/context/repository-builder-vs-pool-worker.md
---

# Repository Builder vs Pool Worker

This project has two Pi actors:

- **Repository Builder** — develops the agent-pool product using auto-discovered `.pi/` resources, local `/goal`, `craft`, and `local-craft-*` agents.
- **Pool Worker** — executes one runtime attempt through an explicitly selected `packages/worker-harness` profile. The approved Pool Proof uses a builder-only profile; full `craft-pool`/`craft-*` execution remains deferred.

A Repository Builder builds the infrastructure and environment in which Pool Workers operate; it does not become one. The Minimal Pool Runtime and Harness are deterministic software, not Pi actors. Repository subject matter never determines actor identity. Without launcher-verified execution context and successful matching preflight, the session is a Repository Builder.

## Local builder ledger

Project-local `/goal` and `.pi/scripts/goal-dispatcher.mjs` keep strict, gitignored evidence for Repository Builder slices: approved-DAG hash, attempts, immutable CRAFTS phase revisions, and completion state. This is development-harness bookkeeping—not Pool Worker authority, product-runtime controller state, or evidence that the supervisor/pool already exists.

Triggered work persists a plan-security checkpoint before Render and allows one C repair plus one re-review; a second critical/high result permits only `stop-and-rescope`. Assess and Tighten each allow one bounded `review → F → re-review` cycle. Further non-security findings require one review-hash-bound, human-attributed decision to defer within existing criteria or stop and rescope.

Explicit retries preserve terminal attempts. Existing v1 journals upgrade through an exact-byte backup, while materially changed approved plans archive the old run and start a fresh journal. These are development-harness controls only—not supervisor or Pool Worker behavior.

## Enforcement

- Runtime-only agents and skills are physically outside `.pi/`.
- Trusted product-runtime code sets actor and independent identity/target/runtime expectations, then supplies launcher-owned context per attempt; preflight requires them to match and rejects stale or replayed contexts.
- Pool Proof explicitly loads one builder-only profile with private Pi config/session roots and workspace-confined sandbox tools. The later full profile retains its separate CRAFTS, model-diversity, Graphify, and artifact checks.
- `actor_identity` exposes sanitized launcher-captured identity for introspection, but capabilities and result acceptance—not model prose—enforce the boundary.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/output/agents-building-agents-handoff|Agents Building Agents Handoff]]

## Raw source

- `docs/raw/context/repository-builder-vs-pool-worker.md`
