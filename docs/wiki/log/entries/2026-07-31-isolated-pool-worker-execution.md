---
title: Isolated Pool Worker Execution
type: source
tags: [log, agent-execution, worker-harness, security]
created: 2026-07-31
updated: 2026-07-31
sources:
  - docs/raw/plans/proposed-build-dag.json
  - docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md
  - docs/raw/adr/orchestrator/ADR-029-agent-tool-surface-and-phase-scoping.md
  - docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md
---

# 2026-07-31 — Isolated Pool Worker Execution

Implemented the `isolated-pool-worker-execution` DAG node: `packages/worker-harness`
preflight hardening plus the `src/domains/agent-execution` implementation.

## What changed

- **Execution context v2.** `pool-worker-execution-context.schema.json` now binds
  `workspace_path`, `attempt_nonce`, `expires_at`, and `max_age_seconds`, making the
  freshness expectation launcher-owned rather than a constant inside preflight. The
  five-minute ceiling from `orchestrator-spec.md` §2.1 still binds as a maximum.
- **Attempt contract.** New `pool-worker-attempt-contract.schema.json` defines the one
  unit payload a DAG-unaware worker executes, carrying criteria provenance and prior
  failure context but no dependency edges.
- **Dependency-free schema validation.** `packages/worker-harness/lib/json-schema-subset.mjs`
  validates instances and checks contract-schema integrity without npm dependencies, so
  preflight can gate an attempt before any paid model call.
- **Domain modules.** Execution-context binding, attempt-contract validation, DAG-topology
  exclusion, credential isolation, phase capability grants, same-attempt backend fallback,
  transcript retention, and bounded workspace cleanup.

## Decisions worth remembering

- Credential isolation is an **allowlist**, built from an empty base. A denylist fails open
  on the provider variable nobody anticipated.
- Backend fallback accumulates cost from **failed** backends. Discarding it would make the
  controller enforce its per-node budget against an under-count.
- The transcript hash covers the **redacted bytes that are persisted**, and verification
  re-reads the durable object's own metadata rather than the local buffer.
- Workspace cleanup has no terminal "retain" decision. After the bounded quarantine the
  answer is `destroy` whatever the audit state, with the failure record preserved.

## Contract seams flagged for integration review

- `pool-worker-execution-context.schema.json` moved to `schema_version: 2` and is a
  breaking change for any launcher emitting v1.
- `pool-worker-attempt-contract.schema.json` overlaps the `work-contracts-direct-intake`
  slice; only the worker-side consumption boundary is defined here.
- Cross-launch nonce replay detection, the durable transcript object store, and the audit
  index remain controller-owned and are injected interfaces here.

## Related

- [[wiki/index|Wiki Index]]
- [[wiki/sources/2026-04-13_adr-032-practical-worker-isolation-baseline|ADR-032: Practical Worker Isolation]]
- [[wiki/sources/2026-04-13_adr-029-agent-tool-surface-and-phase-scoping|ADR-029: Phase-Scoped Agent Tools]]
- [[wiki/sources/2026-04-13_pool-worker-execution-context-schema|Pool Worker Execution Context Schema]]
