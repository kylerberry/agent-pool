# Agent Pool v1 Roadmap

## Current approved build phase

The active plan is the four-node replacement milestone at `docs/raw/plans/proposed-build-dag.json`, approved by Kyler on 2026-08-16:

1. generalize the proven runner to one approved real-repository task (`generalize-proven-runner`);
2. compose authenticated direct-task intake through a SQLite-backed claim loop to one fresh Worker (`compose-direct-intake-to-execution`);
3. build the general deterministic verifier for arbitrary approved task manifests (`general-deterministic-verifier`);
4. surface verified output as a local review branch and PR-ready artifact (`surface-reviewable-output`).

`generalize-proven-runner` is the sole ready root; it remains unreserved until explicitly started. Redis/BullMQ, Tier-2 grading, GitHub automation, connected-component assembly, and the operations baseline are deferred until the tracer path demonstrates the need.

The 17-node functional deployment plan approved on 2026-08-15 was superseded on 2026-08-16 before its root started. Its exact bytes are archived at `docs/raw/plans/superseded-functional-deployment-build-dag.json`; the 17-node sequence below is retained as the reference path for post-milestone work.

## Superseded 17-node functional deployment path (reference)

1. exact Z.ai GLM-5.2 scope, tie-capable tiers, Moonshot-fallback-only policy, and real GLM-5.2 qualification (`deployment-bootstrap-policy-and-glm52-qualification`);
2. real GLM-5.3 qualification at high tier with no active role (`glm53-eligibility-qualification`);
3. parameterized Agent Pool dogfood runner (`parameterized-agent-pool-dogfood-runner`);
4. Z.ai-built credential-strip dogfood task (`credential-strip-zai-dogfood`);
5. authenticated durable direct-task-first service (`direct-task-first-service`);
6. CRAFTS artifact ledger and transcript retention (`crafts-artifact-ledger-and-transcript-retention`);
7. full Pool Worker CRAFTS phase conductor (`full-crafts-phase-conductor`);
8. Tier-1 deterministic evidence attestation (`tier1-evidence-attestation`);
9. Tier-2 composite verdicts and immutable audit (`tier2-composite-verdict-audit`);
10. classified failure retry and governed resolutions (`classified-failure-retry-and-resolution`);
11. controller budget guardrails (`controller-budget-guardrails`);
12. discovered-work quarantine (`discovered-work-quarantine`);
13. queue and restart recovery (`queue-and-restart-recovery`);
14. ADR-015 component PR assembly (`adr015-component-pr-assembly`);
15. GitHub Gate-2 governed review (`github-gate2-governed-review`);
16. single-host operations baseline (`single-host-operations-baseline`); and
17. functional-pool release convergence and end-to-end traceability (`functional-pool-release-convergence`).

Nodes 2 and 3 may run concurrently after node 1; nodes 11 and 12 after node 10; the controller branch (10–13) and delivery branch (14–15) after node 9; and node 16 after node 13 alongside unfinished delivery work. Node 17 is the sole release gate.

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
