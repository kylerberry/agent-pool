---
title: Approved Repository Builder v1 Build DAG
type: source
tags: [source, plan, dag, approved]
created: 2026-07-25
updated: 2026-07-27
audience: repository-builder
subject: development-harness
sources:
  - docs/raw/plans/proposed-build-dag.json
  - docs/raw/plans/domain-map-approval.json
---

# Approved Repository Builder v1 Build DAG

## Summary

Kyler Berry approved a mechanically validated 16-node flat implementation DAG on 2026-07-25. The sole ready root is `domain-scaffolding`; all feature work follows the approved ADR-034 domain-map seam.

The DAG separates the orchestrator-side decomposition harness from the DAG-unaware Pool Worker harness, supports direct-task and free-form-spec intake, and carries work through orchestration, CRAFTS/grading, integration, GitHub delivery, operations, and final traceability.

## Approved plan migration

On 2026-07-27, Kyler approved an acceptance-criteria-only amendment covering predicted-touch scheduling and durable transcript cleanup. The guarded `migrate-plan` operation moved the local ledger from plan SHA-256 `98dab1b9fc64aa67c5a32851402d374922645c5bd4a0f6856c198157b5a3874f` to `32c48976801caaa2a2c5db72ebd74d39c5ae3561d746fc04b8a96808a1183466` without changing node IDs, topology, or completed work.

Migration requires detached approval bound to the exact replacement bytes and rejects active attempts or workspace writers. Content-addressed plan, approval, evidence-manifest, and amendment objects preserve history and support verified idempotent replay. This is an approval-preserving maintenance path, not a second dispatch path; normal execution remains governed by the frozen approved DAG and ledger.

## Interface decision

Application APIs and webhooks belong to the serving domain. Work Intake owns spec/task routes, Integration and Delivery owns GitHub webhook/revision semantics, and Orchestration owns status/escalation commands. HTTP transport remains a policy-free adapter.

## Raw sources

- `docs/raw/plans/proposed-build-dag.json`
- `docs/raw/plans/domain-map-approval.json`
- `docs/raw/context/initial-domain-map.md`
