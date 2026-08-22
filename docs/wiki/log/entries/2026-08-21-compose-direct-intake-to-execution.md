---
title: Compose direct intake to execution (active plan node 2)
type: activity
tags: [direct-task, composition, sqlite, crafts, milestone-2]
created: 2026-08-21
node: compose-direct-intake-to-execution
---

# Compose direct intake to execution

Completed the second node of the active 4-node replacement milestone plan:
`compose-direct-intake-to-execution` (flow C-counsel-R-A-T-S).

## What changed

- **`src/composition/direct-task-service.ts`** — authenticated single-unit `POST /tasks`, owner-scoped `GET /tasks/{submission_id}`, SQLite claim loop.
- **`src/composition/task-runner.ts`** — production-composable runner using the injected `OrchestrationStore` and intake identities.
- **`src/composition/task-manifest.ts`** — production `TaskManifest` validator (harness re-exports it).
- **`src/domains/orchestration/sqlite-store.ts`** — schema v8: `direct_task_submissions`, `direct_task_idempotency`, `importDirectTask`.
- **`test/composition/direct-task-service.test.ts`** — replay after reopen, restart claim, bounded GET, no harness/decomposition imports.

## Verification

- `npx tsc --noEmit` — 0 errors.
- `node --experimental-strip-types --test test/composition/*.test.ts` — 3 pass.
- `npm run test:all` — exit 0.

## Residuals

- Fresh Pi session and provider-credential control path remain the existing Minimal Pool Runtime launcher contract; this node did not re-prove them with a real Pi process.
- `recordProofResult` still does not complete the node; the claim loop must call `acceptResult` then `completeAuthorizedResult`.
