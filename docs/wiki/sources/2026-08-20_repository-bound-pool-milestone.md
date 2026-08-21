---
title: Repository-Bound Pool Milestone
type: source
tags: [source, plan, repository-bound-pool, direct-intake]
created: 2026-08-20
updated: 2026-08-20
sources:
  - docs/raw/plans/proposed-build-dag.json
  - docs/raw/plans/repository-bound-pool-milestone.candidate.json
  - docs/raw/plans/superseded-replacement-milestone-build-dag.json
---

# Repository-Bound Pool Milestone

## Summary

Approved replacement for the prior four-node milestone. It narrows the first usable pool to one configured local repository per pool instance and begins with `configure-repository-bound-pool` before direct intake.

The passed `generalize-proven-runner` is preserved in the archived ledger and prior plan as immutable evidence and reusable code, not repeated in the active topology. Both direct intake and deterministic verification depend on repository-bound configuration. Reviewable output still requires both paths.

## Decisions

- Pool startup configuration—not a task request—owns repository identity, base-ref policy, allowed paths, verification commands, model, bounds, sandbox/runtime root, and one-slot concurrency.
- `POST /tasks` supplies only task content and idempotency. The service creates and persists an immutable execution snapshot from that task plus fixed pool policy.
- No GitHub credential is required for local repository work, local review branches, or the milestone's explicit no-GitHub-delivery scope.
- Multi-repository routing, caller-selected execution policy, automatic push/PR creation, and concurrent execution remain deferred.

## Approval state

Approved by Kyler on 2026-08-20. The active plan is `docs/raw/plans/proposed-build-dag.json`, frozen in the local ledger at SHA-256 `411d462eb00c5a77f2152e04b2835231b7e5161cdb2cc9db8beb5c7c7f18a0c6`. The prior active plan and ledger were archived through `archive-reset`; its passed generalized-runner evidence remains immutable.

## Related

- [[wiki/overview|Project Overview]]
- [[wiki/sources/2026-08-16_local-repository-builder-workflow|Local Repository Builder /goal Workflow]]
- [[wiki/sources/2026-08-13_adr-035-minimal-coherent-dag-nodes|Minimal Coherent DAG Nodes]]

## Raw source

- `docs/raw/plans/proposed-build-dag.json`
- `docs/raw/plans/repository-bound-pool-milestone.candidate.json`
- `docs/raw/plans/superseded-replacement-milestone-build-dag.json`
