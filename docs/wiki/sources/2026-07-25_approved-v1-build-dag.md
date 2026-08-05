---
title: Superseded Repository Builder v1 Build DAG
type: source
tags: [source, plan, dag, superseded]
created: 2026-07-25
updated: 2026-08-05
audience: repository-builder
subject: development-harness
sources:
  - docs/raw/plans/proposed-build-dag.json
  - docs/raw/plans/domain-map-approval.json
---

# Superseded Repository Builder v1 Build DAG

## Status

This page preserves the history of the original full-v1 build sequence. On 2026-08-05, Kyler approved the exact-hash two-node Pool Proof rescope. The prior 17-node local ledger was archived before reset; `docs/raw/plans/proposed-build-dag.json` now contains the approved Pool Proof DAG.

## Historical summary

Kyler Berry approved the original mechanically validated flat implementation DAG on 2026-07-25. Its sole initial ready root was `domain-scaffolding`; feature work followed the approved ADR-034 domain-map seam.

The DAG separates the orchestrator-side decomposition harness from the DAG-unaware Pool Worker harness, supports direct-task and free-form-spec intake, and carries work through orchestration, CRAFTS/grading, integration, GitHub delivery, operations, and final traceability.

## Approved plan migration

On 2026-07-27, Kyler approved an acceptance-criteria-only amendment covering predicted-touch scheduling and durable transcript cleanup. The guarded `migrate-plan` operation moved the local ledger from plan SHA-256 `98dab1b9fc64aa67c5a32851402d374922645c5bd4a0f6856c198157b5a3874f` to `32c48976801caaa2a2c5db72ebd74d39c5ae3561d746fc04b8a96808a1183466` without changing node IDs, topology, or completed work.

Migration requires detached approval bound to the exact replacement bytes and rejects active attempts or workspace writers. Content-addressed plan, approval, evidence-manifest, and amendment objects preserve history and support verified idempotent replay. This is an approval-preserving maintenance path, not a second dispatch path; normal execution remains governed by the frozen approved DAG and ledger.

On 2026-08-02, Kyler approved an append-only amendment to the pending `single-host-operations` node. It now requires a dedicated orchestrator-control-plane decomposition service in the single-host Compose topology, backed by its own Dockerfile or image target, physically separated from Pool Worker containers, capability/secret/resource constrained, and covered by service health, readiness, and decomposition-queue checks. The guarded migration moved the frozen plan from `c5510792537e83a214e13a30e564e89cb392031905a7ac9c37b05d6dc0ec46ba` to `72f34c3ce8c818b1d9db522b63a2e7dc5b13ed7650906a6b8e4846b58d0c54b4` without topology or completed-node changes.

## Interface decision

Application APIs and webhooks belong to the serving domain. Work Intake owns spec/task routes, Integration and Delivery owns GitHub webhook/revision semantics, and Orchestration owns status/escalation commands. HTTP transport remains a policy-free adapter.

## Raw sources

- `docs/raw/plans/proposed-build-dag.json`
- `docs/raw/plans/domain-map-approval.json`
- `docs/raw/context/initial-domain-map.md`
