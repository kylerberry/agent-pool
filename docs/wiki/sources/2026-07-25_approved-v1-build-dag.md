---
title: Superseded Repository Builder v1 Build DAG
type: source
tags: [source, plan, dag, superseded]
created: 2026-07-25
updated: 2026-08-20
audience: repository-builder
subject: development-harness
sources:
  - docs/raw/plans/proposed-build-dag.json
  - docs/raw/plans/domain-map-approval.json
---

# Superseded Repository Builder v1 Build DAG

## Status

This page preserves the original full-v1 build sequence. On 2026-08-05, Kyler approved the
exact-hash two-node Pool Proof rescope; its completed canonical plan is retained at
`docs/raw/plans/completed-pool-proof-build-dag.json`.

## Historical summary

Kyler Berry approved the original mechanically validated flat implementation DAG on 2026-07-25.
Its sole initial ready root was `domain-scaffolding`; feature work followed the approved ADR-034
domain-map seam.

The DAG separates the orchestrator-side decomposition harness from the DAG-unaware Pool Worker
harness, supports direct-task and free-form-spec intake, and carries work through orchestration,
CRAFTS/grading, integration, GitHub delivery, operations, and final traceability.

## Interface decision

The historical full-v1 DAG is retained as plan evidence only. It is superseded and does not grant
current execution authority.
