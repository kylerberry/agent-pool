---
title: Functional Pool Deployment — Direct-Task-First Build Phase
type: source
tags: [source, plan, deployment, direct-task, pool]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/specs/functional-pool-deployment.md
  - docs/raw/plans/functional-pool-deployment-dag.candidate.json
  - docs/raw/plans/functional-pool-deployment-dag.scope-review.json
---

# Functional Pool Deployment

## Status

Proposed and awaiting exact-hash approval. The completed Pool Proof plan remains authoritative and has no ready nodes; its exact canonical bytes are archived at `docs/raw/plans/completed-pool-proof-build-dag.json`. The tested goal-plan validator now requires a detached approval record and verifies candidate, source, scope-review, archive, canonical-plan, and approver bindings. No record exists yet, so activation fails closed.

## Critical path

1. qualify exact Z.ai GLM-5.2/GLM-5.3 under tie-capable, Moonshot-fallback-only policy;
2. parameterize the real dogfood runner;
3. complete the credential-strip Agent Pool dogfood task;
4. expose the durable direct-task-first service;
5. activate full CRAFTS artifacts;
6. activate grading/audit verdicts;
7. complete controller failure/budget/recovery policy;
8. deliver through accepted ADR-015 and mandatory Gate 2; and
9. deploy/restore the service on one host with complete traceability.

Free-form specs/Gate 1, Graphify scheduling, eval calibration, agent-assisted probes, and ADR-037/038 remain post-launch.

## Model decisions

- Building: `zai/glm-5.2` primary, `moonshot/kimi-k2.7-code` fallback.
- Probing after launch: `zai/glm-5.3` primary, `moonshot/kimi-k3` fallback.
- Moonshot is always fallback, never primary.
- GLM-5.2 ties Terra/Kimi K2.7 Code at standard capability; GLM-5.3 ties Sol/Kimi K3 at high capability.
- Bootstrap tiers are provisional; eval calibration follows deployment.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/sources/2026-08-13_adr-039-agent-assisted-probe-execution|ADR-039: Agent-Assisted Probe Execution]]
- [[wiki/sources/2026-08-05_pool-proof-specification|Completed Pool Proof]]
