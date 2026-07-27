# Agent Pool v1 Roadmap

## Pre-deployment blockers

- Replace `packages/worker-harness/config/model-routing.bootstrap.json` role defaults with eval-derived winners once sufficient role/task-class evidence exists.
- Validate every required Pi tool, skill, provider, and model at worker startup.
- Implement and calibrate the CRAFTS phase artifact and tier-2 bootstrap contracts.

## Fast-follow hardening

- Promote local eval telemetry from run-scoped JSONL/manifests to a dual-layer persistence model: retain the files as an inspectable crash-recovery/write-ahead spool, transactionally ingest normalized events and attempt manifests into the orchestrator-owned SQLite audit store, and continue emitting sanitized portable eval-candidate JSON. Add unique event identities, idempotent ingestion, schema migrations, integrity checks, retention/backup policy, and explicit telemetry-only-to-formal-eval promotion state. Keep `.pi/goal-runs/` as disposable local runtime state rather than the durable source of truth; use ADR-033's WAL-safe backup process for SQLite.
- Replace reconciliation-based cross-store delivery with transactional outbox/inbox and stronger fencing if operational evidence warrants it.
- Add rootless/read-only/seccomp sandboxing, default-deny egress, GitHub App short-lived tokens, image signatures, and SBOM verification.
- Define formal RPO/RTO, automated alert routing, metrics dashboards, replicated state, and recurring fault-injection/restore drills.
- Replace provisional `passed` semantics with explicit `attempt_passed`, `integrating`, and `verified` lifecycle states; fence integration by head SHA and route manual fixes through normal grading unless explicitly force-passed.
- Add graceful phase-boundary budget stop checks and, where supported, provider-side hard spend/token limits.
