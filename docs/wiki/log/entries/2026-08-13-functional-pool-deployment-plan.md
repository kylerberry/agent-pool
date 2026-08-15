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

Candidate SHA-256: `846b7d7de37563e6e43abc659569b8736a2b7605e3fee0295da63bda1dc61017` (historical; this nine-node candidate was superseded the same day by the ADR-035 17-node reslice at SHA-256 `82cfe59c88b57e5fbcea27ce26d6c2406fea360e8e3025390d920326b01a6b9a` — see [[wiki/log/entries/2026-08-13-functional-pool-deployment-reslice|the reslice entry]]).

The completed Pool Proof canonical plan is archived byte-for-byte at SHA-256 `fe62bd9b…d8e5`. A red-tested detached-approval validator now binds candidate, source, scope-review, archive, canonical-plan, and approver bytes through `validate-goal-plan.mjs`; the existing generic approval notes are insufficient and no deployment approval record exists yet.
