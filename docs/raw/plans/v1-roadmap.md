# Agent Pool v1 Roadmap

## Current proposed build phase

The completed Pool Proof is followed by the unapproved nine-node direct-task-first deployment candidate:

- `docs/raw/specs/functional-pool-deployment.md`
- `docs/raw/plans/functional-pool-deployment-dag.candidate.json`
- `docs/raw/plans/functional-pool-deployment-dag.scope-review.json`

No node becomes ready until the exact candidate/spec hashes receive human approval and the canonical plan/ledger are activated through the guarded `/goal` path.

## Deployment critical path

1. exact Z.ai GLM-5.2/GLM-5.3 scope, tie-capable tiers, Moonshot-fallback-only policy, and real qualification;
2. parameterized Agent Pool dogfood runner;
3. Z.ai-built credential-strip dogfood task;
4. authenticated durable direct-task-first service;
5. full Pool Worker CRAFTS lifecycle and append-only artifacts;
6. Tier-1/Tier-2 bootstrap grading and immutable audit verdicts;
7. retry/budget/failure/discovery/reconciliation policy;
8. accepted ADR-015 GitHub delivery with mandatory Gate 2; and
9. single-host deployment, backup/restore, operations, and end-to-end traceability.

Bootstrap routing is permitted for initial deployment when exact models are qualified and evidence is explicitly marked provisional. Eval-derived routing is post-launch calibration, not a pre-deployment blocker. Moonshot models remain fallback-only and cannot become primary through bootstrap or eval publication.

## Post-launch product work

- Implement ADR-039's one-call agent-assisted probe profile and bounded evidence projection into later C sessions.
- Add free-form `POST /specs`, decomposition, mechanical proposal validation, and Gate 1.
- Enforce ADR-035 scope-review metadata in product Work Intake and integrate ADR-036 discovered/probe evidence into governed amendment.
- Implement repository onboarding, Graphify index build/refresh, and predicted-touch scheduling.
- Build the builder-first eval row, then other role-specific rows as evidence justifies them.
- Implement review-comment continuation.
- Reassess proposed ADR-037 when Gate 1 is built.
- Reassess proposed ADR-038 after real ADR-015 delivery data exists.

## Fast-follow hardening

- **P0 — target-repository codebase-knowledge hardening:** content-level secret scanning/redaction; OS-enforced default-deny egress for Graphify/indexing; OS read-only mount/sandbox isolation; and reproducible worker-image build/smoke attestation.
- Promote local eval telemetry from run-scoped JSONL/manifests to a dual-layer spool plus idempotent orchestrator-owned SQLite ingestion and explicit telemetry-to-formal-eval promotion.
- Replace reconciliation-based cross-store delivery with transactional outbox/inbox and stronger fencing if operational evidence warrants it.
- Add rootless/seccomp hardening, short-lived GitHub App tokens, image signatures, and SBOM verification.
- Define formal RPO/RTO, alert routing, dashboards, replication, and recurring fault-injection/restore drills.
- Replace provisional `passed` semantics with explicit `attempt_passed`, `integrating`, and `verified` states if operational evidence warrants the migration.
- Add graceful phase-boundary budget stops and provider-side hard spend/token limits where supported.
- Add controller-approved target-repository external knowledge providers only after pinned read-only onboarding with scoped secrets/egress, phase grants, and provenance; write-capable sinks remain separately approved.
