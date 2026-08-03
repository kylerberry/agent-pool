---
date: 2026-08-03
type: refactor
scope: local development harness
---

# Simplify local work journal

Refactored the Repository Builder-only local development harness under `.pi/` to reduce it to a crash-resistant work journal while preserving approved-DAG validation, frontier derivation, stable attempts, idempotency, writer isolation, append-only revisions, retries, completion, and original-criteria plumbing.

## What changed

- Extracted one source of truth for approved-DAG validation and SHA-256 into `.pi/scripts/goal-plan.mjs`.
- Extracted one source of truth for journal normalization, frontier derivation, cursor calculation, bounded transitions, checkpoint/revision rules, and human-decision handling into `.pi/scripts/goal-journal.mjs`.
- Rewrote `.pi/scripts/goal-dispatcher.mjs` as a CLI/filesystem adapter using those modules.
- Removed `migrate-plan` and its content-addressed object store, detached approval envelope, inode-chain TOCTOU ceremony, and completed-evidence re-attestation.
- Added `record-checkpoint` and `record-decision` commands with strict local validators.
- Added `upgrade-ledger` (v1 to v2, backup-first) and `archive-reset` (backup whole run, reset ledger) commands.
- Made telemetry consume the dispatcher-written `next_action` from the workspace guard and removed telemetry's own phase state machine.
- Added regression tests for C revision, plan-security persistence, review caps/decisions, legacy ledger normalization, telemetry transition parity, and removed migration behavior.
- Updated `.pi/skills/goal`, `.pi/skills/craft`, `.pi/skills/craft-hitl`, and the Repository Builder vs Pool Worker actor-boundary docs.

## Non-goals preserved

- No changes under `packages/worker-harness/`.
- No weakening of Pool Worker contracts, shared schemas, or product-runtime semantics.
- The ignored active `crafts-grading-flow-attempt-1` ledger is preserved through the v1→v2 compatibility path; it is not edited manually.
