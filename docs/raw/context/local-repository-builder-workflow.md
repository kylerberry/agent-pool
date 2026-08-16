---
audience: repository-builder
subject: development-harness
status: accepted
---

# Local Repository Builder /goal Workflow — Canonical Authority

This document is the current authority for local Repository Builder plan governance: how a
local build plan is approved, validated, dispatched, decided, and reset. Skills, prompts, and
wiki pages defer to it. Historical exact-hash deployment artifacts remain auditable evidence
but no longer govern local dispatch; see "Historical evidence is not dispatch authority" below.

## Plan authorization

- Any **structurally valid** plan can initialize or archive-reset the local ledger. There is no
  hard-coded list of known canonical plans and no detached candidate/source/scope/archive
  approval requirement.
- Structural validity means: `schema_version: 1`; five-field ADR-018 nodes (`id`, `intent`,
  `change_spec`, `acceptance_criteria`, `depends_on`); unique IDs; resolvable dependencies; no
  cycles; at least one ready root; bounded field sizes.
- Authorization requires exactly one human-attributed `approval` object inside the plan:
  `approved_by` (non-empty), `approved_at` (date-time), optional bounded `notes`.
- The dispatcher reads the plan through the shared verified repository-file boundary
  (`.pi/scripts/verified-repository-file.mjs`): root containment, no final or ancestor symlinks,
  regular files only, size bounds, and post-open identity re-checks. Bytes are read and hashed
  from the verified descriptor.
- Every mutating dispatcher operation consumes **one verified snapshot** of the plan acquired
  under the ledger lock: the snapshot's SHA-256 must equal the ledger's `frozen_plan_sha`, and
  acceptance criteria for artifact validation derive from that same snapshot. A transient plan
  swap cannot persist criteria that never matched the frozen approved plan.

## Conditional domain-map governance (ADR-034 seam)

- The plan-level boolean `domain_boundaries_changed` controls the ADR-034 domain-map gate:
  - `true`: the plan requires a verified domain-map approval record
    (`docs/raw/plans/domain-map-approval.json`) with a matching map SHA-256, read through the
    verified repository-file boundary.
  - `false` or absent (legacy plans): no domain-map files are read. Absence is interpreted as
    "no boundary change".
  - Any non-boolean value fails closed.
- Newly proposed candidate plans must always emit the boolean. The signal is a human-approved
  semantic declaration: a false declaration skips map reapproval only if the approver accepts
  that no boundaries moved.

## Optional ADR-035 scope-review sidecar

- Ordinary nodes need no scope-review metadata. `scope_review_path` is an optional plan field.
- When present, the sidecar is a root-contained regular JSON file read through the verified
  boundary, containing `{schema_version: 1, nodes: {<plan-node-id>: {rationale}}}`. Sidecar node
  IDs must be a subset of plan node IDs and each exceptional record needs a concise non-empty
  rationale.
- The sidecar is review metadata for exceptional (cross-domain, multi-contract, multi-suite)
  nodes only. It cannot alter node payloads, dependencies, criteria, readiness, or runtime
  state, and it is not dispatch authority.

## Direct attempt-scoped human decisions

- After exhausted local reviews (a second `needs_fix` Assess/Tighten, or a second blocking
  plan-security checkpoint), the required human decision binds directly to the attempt and an
  exact target — not to an artifact hash:
  `{kind: "human-decision", attempt_id, target: {type: "phase"|"checkpoint", name, revision}, outcome, decided_by, reason}`.
- `next_action` reports the exact expected target; recording requires exact structural equality.
  Wrong attempts, stale or future revisions, non-exhausted targets, unsupported target types,
  blank actors/reasons, and unknown fields are rejected.
- Outcomes remain `defer-and-proceed` (only within the existing criteria, and only for findings
  below high severity on plan-security) and `stop-and-rescope`.
- Legacy ledgers may contain historical `bound_to` hash-bound decision records. They are kept
  immutable as evidence and still resolve for evaluation only when the hash matches exactly one
  record of the same attempt; ambiguity or absence fails closed and never authorizes new work.
  New decisions must use the direct schema.

## One node per invocation, with explicit opt-in continuation

- Default `/goal` invocation reserves and executes exactly one ready node, then stops and
  reports the frontier.
- The conductor may continue sequentially through additional ready nodes **only when the user
  explicitly requests continue-ready in that invocation**. Each iteration must: complete the
  current node and persist its completion; release the workspace guard; recompute the frontier;
  re-run the verified-plan drift check and the full preflight; then reacquire the guard through
  an ordinary `start` and run full fresh-context CRAFTS.
- Continuation stops immediately on any failure, escalation, unresolved human decision, plan
  drift, unavailable or unenforceable model pairing, failed preflight, empty frontier, guard
  conflict, or user interruption. It never retries, selects a blocked node, bypasses CRAFTS, or
  runs writers in parallel. The dispatcher itself remains single-attempt; continuation is a
  conductor behavior.

## Ledger safety (unchanged)

- One active writer per worktree (workspace guard), frozen-plan drift detection, full per-node
  CRAFTS with model diversity, bounded review loops, and plan-security checkpoints are all
  preserved.
- `archive-reset` validates everything before mutating: the verified plan snapshot must match
  the supplied confirmation hash, no attempt may be active, and the run is copied and the
  archived ledger verified (regular non-symlinked file, digest match) **before** the active run
  is removed. Failures leave the active ledger and prior archive entries unchanged. The
  operation is recoverable but not one atomic filesystem transaction.

## Historical evidence is not dispatch authority

The following remain in the repository as immutable historical evidence. No local script or
agent may treat them as authorization for dispatch, initialization, or archive-reset:

- `docs/raw/specs/pool-proof.md` and the completed Pool Proof plan/ledger history;
- `docs/raw/specs/functional-pool-deployment.md`;
- `docs/raw/plans/functional-pool-deployment-dag.candidate.json`;
- `docs/raw/plans/functional-pool-deployment-dag.scope-review.json`;
- `docs/raw/plans/functional-pool-deployment-approval.json` (detached exact-hash approval);
- `docs/raw/plans/completed-pool-proof-build-dag.json`;
- `docs/raw/plans/superseded-functional-deployment-build-dag.json` (the 17-node plan approved
  2026-08-15 and superseded 2026-08-16 before its root started).

The active local plan is the four-node replacement milestone at `docs/raw/plans/proposed-build-dag.json`
with its embedded human-attributed `approval` (Kyler, 2026-08-16). The proposal artifact
`docs/raw/plans/replacement-milestone-dag.candidate.json` is retained unchanged as evidence of
what was approved; checkouts whose ledger freezes a superseded plan's SHA must `archive-reset`
before dispatching the active plan.
