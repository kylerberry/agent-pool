# Agent Pool v1 Roadmap

## Pre-deployment blockers

- Replace `packages/worker-harness/config/model-routing.bootstrap.json` role defaults with eval-derived winners once sufficient role/task-class evidence exists.
- Validate every required Pi tool, skill, provider, and model at worker startup.
- Implement and calibrate the CRAFTS phase artifact and tier-2 bootstrap contracts.

## Fast-follow hardening

- **P0 — target-repository codebase-knowledge hardening:** extend the ADR-032 baseline with content-level secret scanning/redaction for target-derived artifacts; OS-enforced default-deny egress for Graphify and related indexing processes; OS read-only mount/sandbox isolation for target workspaces; and reproducible worker-image build-and-smoke attestation for pinned Graphify and runtime capabilities. These controls augment, rather than revise, ADR-032's accepted v1 baseline.

- Promote local eval telemetry from run-scoped JSONL/manifests to a dual-layer persistence model: retain the files as an inspectable crash-recovery/write-ahead spool, transactionally ingest normalized events and attempt manifests into the orchestrator-owned SQLite audit store, and continue emitting sanitized portable eval-candidate JSON. Add unique event identities, idempotent ingestion, schema migrations, integrity checks, retention/backup policy, and explicit telemetry-only-to-formal-eval promotion state. Keep `.pi/goal-runs/` as disposable local runtime state rather than the durable source of truth; use ADR-033's WAL-safe backup process for SQLite.
- Replace reconciliation-based cross-store delivery with transactional outbox/inbox and stronger fencing if operational evidence warrants it.
- Add rootless/read-only/seccomp sandboxing, default-deny egress, GitHub App short-lived tokens, image signatures, and SBOM verification.
- Define formal RPO/RTO, automated alert routing, metrics dashboards, replicated state, and recurring fault-injection/restore drills.
- Replace provisional `passed` semantics with explicit `attempt_passed`, `integrating`, and `verified` lifecycle states; fence integration by head SHA and route manual fixes through normal grading unless explicitly force-passed.
- Add graceful phase-boundary budget stop checks and, where supported, provider-side hard spend/token limits.
- Add controller-approved target-repository external knowledge providers. Repository-declared MCP or similar configuration must remain untrusted and never auto-launch: onboarding must pin the server/image and version, allowlist read-only tools, scope secrets and egress, grant capabilities per phase, and record provider/tool/version provenance. Evaluate a separately approved write-capable external knowledge sink only after the read-only provider path is proven.
