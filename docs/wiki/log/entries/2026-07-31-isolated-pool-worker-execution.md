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

## Independent review round

The CRAFTS Assess phase originally ran on the same model as Render, which does not satisfy the
builder/evaluator diversity guarantee. A second Assess was run on an independent model
(GPT-5.x via Codex) and found six defects the same-model pass missed — five High, one Medium.
All six were valid and are fixed:

1. Repository commands inherited the host `HOME`, exposing file-based provider and forge
   credentials (`~/.git-credentials`, `~/.netrc`, `~/.npmrc`, `~/.config/gh/hosts.yml`). The
   original test asserted `HOME` was *retained*, so it misencoded the criterion.
2. `startedAt` was unvalidated; a `NaN` start time makes every `now >= deadline` comparison
   false, so an `audit_incomplete` workspace would be retained forever.
3. `markAuditComplete()` took no argument, so any caller could authorize destruction without
   having run the retention pipeline.
4. Verification read store-reported metadata rather than the stored bytes, so a store that
   truncated the object during `put` could still report the expected digest.
5. Preflight checked only that two mutable config files agreed, not that they held the exact
   five-model set from the specification.
6. Cost validation allowed `amount` without `currency`, letting an unknown-currency charge be
   summed into a later backend's currency total.

**Process lesson:** same-model Assess found none of these. The independence requirement is
load-bearing, not ceremony.

## Decisions worth remembering

- Credential isolation is an **allowlist**, built from an empty base. A denylist fails open
  on the provider variable nobody anticipated.
- Backend fallback accumulates cost from **failed** backends. Discarding it would make the
  controller enforce its per-node budget against an under-count.
- The transcript hash covers the **redacted bytes that are persisted**, and verification
  re-reads and locally rehashes the durable object's stored bytes rather than trusting
  store-reported metadata or the local buffer.
- Workspace cleanup has no terminal "retain" decision. After the bounded quarantine the
  answer is `destroy` whatever the audit state, with the failure record preserved.

## Contract seams — integration owner decisions (2026-08-01)

- **Criteria-provenance vocabulary: resolved.** The canonical value is `direct_task`,
  matching the `work-contracts-direct-intake` node's own acceptance criterion. The
  worker-side enum was `direct-task` and has been corrected. `criteria_origin` remains the
  field name.
- **Execution context v2: accepted.** `pool-worker-execution-context.schema.json` stays at
  `schema_version: 2`. It is a breaking change for any launcher emitting v1, but no launcher
  exists yet, so the change was taken at its cheapest point.
- **Work-contract → attempt-contract projection: open.** Both upstream producers legitimately
  carry `depends_on`; the worker must never see it. The transform that strips topology and
  hands down exactly one unit is owned by neither adjacent slice. Under discussion; the
  worker-side receiving assertion (`findDagTopology`) is in place either way.
- Cross-launch nonce replay detection, the durable transcript object store, and the audit
  index remain controller-owned and are injected interfaces here.

## Related

- [[wiki/index|Wiki Index]]
- [[wiki/sources/2026-04-13_adr-032-practical-worker-isolation-baseline|ADR-032: Practical Worker Isolation]]
- [[wiki/sources/2026-04-13_adr-029-agent-tool-surface-and-phase-scoping|ADR-029: Phase-Scoped Agent Tools]]
- [[wiki/sources/2026-04-13_pool-worker-execution-context-schema|Pool Worker Execution Context Schema]]
