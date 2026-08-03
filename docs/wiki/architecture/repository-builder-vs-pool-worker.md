---
title: Repository Builder vs Pool Worker
type: architecture
tags: [agents, pi, harness, runtime]
created: 2026-04-13
updated: 2026-08-03
audience: both
subject: development-harness
sources:
  - docs/raw/context/repository-builder-vs-pool-worker.md
---

# Repository Builder vs Pool Worker

This project has two Pi actors:

- **Repository Builder** — develops the agent-pool product using auto-discovered `.pi/` resources, local `/goal`, `craft`, and `local-craft-*` agents.
- **Pool Worker** — executes one runtime node attempt using the explicitly loaded `packages/worker-harness/`, `craft-pool`, and runtime `craft-*` agents.

Repository subject matter never determines actor identity. Without a valid supervisor-issued execution marker and successful worker preflight, the session is a Repository Builder.

## Local builder ledger

Project-local `/goal` and `.pi/scripts/goal-dispatcher.mjs` keep strict, gitignored evidence for Repository Builder slices: approved-DAG hash, attempts, immutable CRAFTS phase revisions, and completion state. This is development-harness bookkeeping—not Pool Worker authority, product-runtime controller state, or evidence that the supervisor/pool already exists.

Triggered work persists a plan-security checkpoint before Render and allows one C repair plus one re-review; a second critical/high result permits only `stop-and-rescope`. Assess and Tighten each allow one bounded `review → F → re-review` cycle. Further non-security findings require one review-hash-bound, human-attributed decision to defer within existing criteria or stop and rescope.

Explicit retries preserve terminal attempts. Existing v1 journals upgrade through an exact-byte backup, while materially changed approved plans archive the old run and start a fresh journal. These are development-harness controls only—not supervisor or Pool Worker behavior.

## Enforcement

- Runtime-only agents and skills are physically outside `.pi/`.
- The supervisor sets the actor and expected identity/target environment values, then supplies launcher-owned `.agent-pool/execution-context.json` per attempt; preflight requires them to match and rejects stale markers.
- `craft-pool` runs `packages/worker-harness/scripts/preflight.mjs` before model work and fails closed.
- The worker package validates context, capabilities, exact models, model diversity, Graphify, and bundled contracts.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/output/agents-building-agents-handoff|Agents Building Agents Handoff]]

## Raw source

- `docs/raw/context/repository-builder-vs-pool-worker.md`
