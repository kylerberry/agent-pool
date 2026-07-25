---
title: Approved Repository Builder v1 Build DAG
type: source
tags: [source, plan, dag, approved]
created: 2026-07-25
updated: 2026-07-25
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

## Interface decision

Application APIs and webhooks belong to the serving domain. Work Intake owns spec/task routes, Integration and Delivery owns GitHub webhook/revision semantics, and Orchestration owns status/escalation commands. HTTP transport remains a policy-free adapter.

## Raw sources

- `docs/raw/plans/proposed-build-dag.json`
- `docs/raw/plans/domain-map-approval.json`
- `docs/raw/context/initial-domain-map.md`
