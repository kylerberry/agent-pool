# ADR-038: Node-Level Mainline Integration

**Status:** Proposed
**Would supersede:** ADR-015 (PR granularity by connected component)
**Would amend:** ADR-017 (test-suite storage and re-verification)

## Context

Connected-component delivery holds a dependency chain on a long-lived integration branch until the whole component is ready. That branch drifts from `main`, accumulates conflicts, and makes a deliberately incomplete-but-safe probe difficult to use as the stable base for downstream work.

## Decision

Every independently verifiable DAG node receives a short-lived delivery branch and node pull request against the target repository's `main`. A node PR reaches Gate 2 only after its machine verdicts pass; required human review remains mandatory. GitHub auto-merge may merge it once required reviews and checks pass. Where configured, GitHub merge queue is preferred; otherwise ordinary auto-merge plus verification of the merged commit is accepted.

A trusted Integration and Delivery adapter verifies a signed, replay-protected GitHub merge event and the exact merged commit and required status check. Only then does the controller treat the node as integrated and unlock dependent nodes. A Worker-local green result is a merge candidate, never a dependency-unlock signal.

Every node merged to `main` must be independently production-safe. Feature flags protect incomplete user-visible behavior where needed; additive schemas, internal seams, fixtures, and non-routable adapters need no flag. Agent Pool integrates code but does not deploy it: target-repository CI/CD determines deployment.

## Consequences

This removes long-lived component branches and lets downstream Workers derive from current `main`. It increases PR volume but makes each review and merge small, independently auditable, and compatible with merge-queue conflict handling. It requires node lifecycle handling to distinguish Worker success, Gate 2 review, merged verification, and dependency eligibility.

ADR-017's integration re-verification moves to the exact merged or merge-queue commit; a node does not unlock dependents until that verification succeeds.
