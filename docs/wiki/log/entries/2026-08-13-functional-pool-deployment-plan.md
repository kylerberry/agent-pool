# 2026-08-13 — Functional pool deployment plan

Recorded the proposed nine-node direct-task-first path from completed Pool Proof to a recoverable personal deployment. The exact candidate is unapproved and does not replace the completed canonical plan.

Decisions:

- approve exact Z.ai GLM-5.2/GLM-5.3 target scope, subject to live qualification;
- replace forced unique ranks with provisional tie-capable tiers;
- route building GLM-5.2→Kimi K2.7 Code and future probing GLM-5.3→Kimi K3;
- make Moonshot fallback-only in every bootstrap/eval-derived policy;
- permit bootstrap routing for initial deployment and move eval calibration post-launch;
- deploy direct tasks before free-form specs/Gate 1;
- retain accepted ADR-015 and defer ADR-037/038 until relevant real evidence exists;
- accept ADR-039's one-call agent-assisted probe design but defer implementation until after deployment.

Candidate SHA-256: `846b7d7de37563e6e43abc659569b8736a2b7605e3fee0295da63bda1dc61017`.

The completed Pool Proof canonical plan is archived byte-for-byte at SHA-256 `fe62bd9b…d8e5`. A red-tested detached-approval validator now binds candidate, source, scope-review, archive, canonical-plan, and approver bytes through `validate-goal-plan.mjs`; the existing generic approval notes are insufficient and no deployment approval record exists yet.
