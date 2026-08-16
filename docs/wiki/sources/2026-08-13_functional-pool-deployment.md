---
title: Functional Pool Deployment — Direct-Task-First Build Phase
type: source
tags: [source, plan, deployment, direct-task, pool]
created: 2026-08-13
updated: 2026-08-16
sources:
  - docs/raw/specs/functional-pool-deployment.md
  - docs/raw/plans/functional-pool-deployment-dag.candidate.json
  - docs/raw/plans/functional-pool-deployment-dag.scope-review.json
---

# Functional Pool Deployment

## Status

Approved and activated on 2026-08-15; **superseded on 2026-08-16** by the four-node replacement milestone plan (`docs/raw/plans/proposed-build-dag.json`) before any node started — no 17-node work was reserved or executed. The superseded plan's exact bytes are archived at `docs/raw/plans/superseded-functional-deployment-build-dag.json`. The detached exact-hash approval artifacts are retained **historical evidence** and have not governed local dispatch since the 2026-08-16 governance simplification (`docs/raw/context/local-repository-builder-workflow.md`). The completed Pool Proof canonical bytes remain archived at `docs/raw/plans/completed-pool-proof-build-dag.json`.

## Critical path

1. establish the deployment bootstrap policy and live-qualify exact GLM-5.2 as the active builder primary under tie-capable, Moonshot-fallback-only routing;
2. live-qualify exact GLM-5.3 at high tier with no active role (parallel with 3 after node 1);
3. parameterize the real dogfood runner;
4. complete the credential-strip Agent Pool dogfood task;
5. expose the durable direct-task-first service;
6. accept and retain only schema-valid, append-only CRAFTS artifacts with verified transcript objects or `audit_incomplete`;
7. activate the full CRAFTS phase conductor;
8. emit immutable recomputed Tier-1 attestations;
9. form Tier-2 composite verdicts and the immutable audit chain;
10. govern classified failure, retry, freezing, and the five resolutions;
11. enforce per-node/per-DAG budget ceilings (parallel with 12 after node 10);
12. quarantine and classify discovered work without topology authority;
13. reconcile queue, lease, result, startup, and migration interruptions idempotently;
14. assemble reverified connected components as ADR-015 PRs awaiting Gate 2 (parallel with 10–13 after node 9); stale-green returns to governed failure handling with no GitHub side effect;
15. complete or return awaiting PRs only through authorized, signature-verified, replay-protected human Gate-2 records; comments are inert bounded revision data;
16. operate, back up, empty-host restore, and clean up the stack on one private host (parallel with unfinished delivery work); and
17. converge the restored release through one controlled direct-task-to-Gate-2 run — the sole release claim.

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
