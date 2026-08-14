---
title: attempt-provenance-store delivers append-only attempt provenance
type: operation
tags: [orchestration, persistence, sqlite, provenance, crafts]
created: 2026-08-03
updated: 2026-08-03
sources:
  - docs/raw/context/append-only-persistence-in-sqlite.md
  - docs/raw/plans/proposed-build-dag.json
---

# `attempt-provenance-store` — append-only attempt provenance

The node split out of `crafts-grading-flow` after its attempt-1
`stop-and-rescope`. It owns the two blockers that were orchestration territory
rather than grading territory. See
[[wiki/log/entries/2026-08-03-crafts-grading-flow-rescope|the rescope entry]].

## Delivered

Schema migrations **v3–v5** in `src/domains/orchestration/sqlite-store.ts`:

- `attempt_routing_decisions` — one row per attempt, written inside the same
  transaction as the `attempts` row. It records only the canonical builder
  selected at dispatch and is read by `getBuilderRoutingByAttemptId`. Builder
  routing is reusable for Pool Proof now; evaluator-execution provenance and
  Tier-2 independence are deferred until grading records an actual evaluator
  invocation.
- `phase_artifacts` — keyed `(attempt_id, phase, revision)`, revision allocated
  inside the INSERT. A phase legitimately repeats within one attempt, so a
  `needs_fix` T and its later passing T both persist. It accepts only C/R/A/F/T/S
  plus `passed|needs_fix|failed|blocked`, and references a real attempt through
  an `ON DELETE RESTRICT` foreign key.
- `BuilderRoutingResolver` — an injected parameter on `dispatchReadyFrontier`.
  Orchestration validates supplied model IDs through Model Routing's canonical
  registry but never selects or reorders it. Resolver outages, invalid routing,
  and attempt-creation failures return bounded typed skipped-node outcomes rather
  than looking like an empty frontier.

## Two defects found, both by mutation testing

Neither was found by reading, and both had passing tests over them.

**The concurrency test could not fail.** `recordPhaseArtifact` contains no
`await` and `node:sqlite` is synchronous, so a `Promise.all` of four inserts
serialized. The assertion held regardless of `BEGIN IMMEDIATE`, the RESERVED
lock, or the `UNIQUE` constraint. Resolved by removing the read-modify-write
entirely rather than asserting it: allocation moved inside the INSERT.

**`INSERT OR REPLACE` bypassed append-only enforcement**, rewriting a
`needs_fix` artifact to `passed` through both triggers — precisely the
grading-integrity mutation the design exists to prevent. The first fix,
`PRAGMA recursive_triggers = ON`, was rejected by mutation testing: the setting
is per-connection and the suite stayed green without it. Migration v4 replaces it
with schema-level `BEFORE INSERT` conflict guards. Migration v5 removes the
preemptive evaluator column entirely and makes phase artifacts referentially
valid while preserving the guards. Recorded canonically in
`docs/raw/context/append-only-persistence-in-sqlite.md` (Append-Only Persistence in SQLite).

## Verification

583/583 repository tests, 41/41 worker-harness tests, `tsc --noEmit` clean.
Three mutation tests confirm the key assertions fail when their mechanism is
removed.

## Honest limitations

- **No phase ran independently.** C, R, A, F, T all ran on `claude-opus-5` in one
  Claude Code session. Every artifact records this in `risks`.
- **No production Pool Proof caller exists.** Builder routing is ready for one;
  phase artifacts remain latent until runtime CRAFTS writes them, and evaluator
  execution provenance remains deliberately deferred to grading.
- **`DROP TRIGGER` and `PRAGMA writable_schema` defeat the guards** and were not
  assessed. Deferred to `single-host-operations`.
- Percent-encoded locators are accepted at storage; consumers must apply realpath
  containment and must not decode before resolving.
- `ON DELETE RESTRICT` preserves phase evidence but leaves future attempt-retention
  and operator cleanup policy unresolved.
