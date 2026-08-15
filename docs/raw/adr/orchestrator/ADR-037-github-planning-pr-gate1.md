# ADR-037: GitHub Planning PRs as Editable Gate 1 Manifests

**Status:** Proposed — deferred until after direct-task-first deployment (2026-08-13)
**Amends:** ADR-003 (DAG as gated checkpoint), ADR-024 (amend-DAG)

## Context

ADR-003 requires human approval of a persisted candidate DAG but leaves the collaboration surface unspecified. ADR-024 requires partial re-decomposition after a boundary failure. An API/CLI-only approval path would require the controller to orchestrate every human or user-agent edit, despite GitHub already providing controlled editing, review, validation, identity, and history in the target repository.

## Decision

The canonical editable DAG manifest lives in the target repository at `.agent-pool/dags/<work-id>.json`. The controller seeds or updates it through a GitHub planning pull request. Repository collaborators—including authorized user agents—may add, remove, or rewire nodes in that PR; GitHub repository policy owns who may do so.

Planning-PR CI validates only deterministic constraints: manifest schema, unique identifiers, dependency references, acyclicity, target-repository/head binding, and reserved-path ownership. It does not invoke decomposition or CRAFTS.

Gate 1 is satisfied only when the planning PR merges. The merge commit, manifest digest, repository/head binding, GitHub review/event reference, approval timestamp, and approver identity are retained as approval evidence. A qualifying review remains the human decision; auto-merge may remove the information-free final click. The controller dispatches only from that merged, validated manifest revision.

A failed probe or other topology/scope discovery may cause the controller to open an amendment planning PR containing the last approved manifest plus bounded discovery evidence. A human or authorized user agent edits the unmet remainder directly; invoking the decomposer is optional. The amended manifest receives the same deterministic validation and a new merged Gate 1 revision before its new nodes dispatch. Workers never edit or approve DAG topology.

## Consequences

This proposal is not part of the 17-node functional deployment path. Direct tasks do not use decomposition or Gate 1, so planning PRs add no launch value. Reassess only when free-form specification intake and Gate 1 implementation begins.

GitHub becomes the collaboration and audit surface for DAG construction without making GitHub permissions controller policy. The controller trusts only immutable merged-manifest evidence, not comments, mutable PR state, or a Worker report.

This replaces ADR-024's mandatory decomposer rerun with an optional aid. Target repositories must install/configure the GitHub integration and reserve the manifest path. The existing API/CLI approval path remains a fallback for repositories where GitHub is unavailable or inappropriate.
