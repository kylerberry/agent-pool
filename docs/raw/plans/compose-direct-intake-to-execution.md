# compose-direct-intake-to-execution — implementation record

**Status:** Completed 2026-08-21  
**Plan node:** `docs/raw/plans/proposed-build-dag.json` → `compose-direct-intake-to-execution`  
**Depends on:** `generalize-proven-runner`

## Binding decisions (this node)

- Composed `POST /tasks` accepts one `unit` only. `acceptDirectTasks()` remains the general ADR-028 boundary and may still accept `units`.
- Per-submission `TaskManifest` combines caller-authored `intent`, `change_spec`, and `acceptance_criteria` with service-controlled `target_repo_path`, `base_commit`, `allowed_changed_paths`, `verification_commands`, `model`, and `bounds`. The HTTP body does not supply those service-controlled fields.
- Durable caller-scoped idempotency, ownership, work/node, and `TaskManifest` JSON commit in one Orchestration SQLite transaction (`importDirectTask`). Schema version 8.
- `GET /tasks/{submission_id}` is authenticated and owner-scoped. Another caller receives 404. The projection is capped to submission/work/node identities, status, attempt id, and terminal result id/status/commit-present/checks.
- Claim loop is SQLite-backed: reclaim expired leases, create one attempt, claim a lease, run `runClaimedTask` against the service-owned store and intake identities, then `acceptResult` + `completeAuthorizedResult`. No Redis or BullMQ.
- Production composition must not import `packages/pool-proof-harness`. The harness `task-manifest.ts` re-exports the production validator.
- Service tests inject a labeled fake `PiLauncher` and sandbox command seam. Production injects `createPoolProofPiLauncher`.

## Non-goals retained

Decomposition, Gate 1, full CRAFTS, Tier-2 grading, GitHub delivery, paid-model CI, and hand-authored DAG dispatch.
