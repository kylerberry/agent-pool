---
title: ADR-037: GitHub Planning PRs as Editable Gate 1 Manifests
type: source
tags: [source, adr, dag, github, gate-1]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-037-github-planning-pr-gate1.md
---

# ADR-037: GitHub Planning PRs as Editable Gate 1 Manifests

> ⚠️ Proposed: no implementation behavior changes until accepted.

A target-repository planning PR owns the editable canonical DAG manifest. Deterministic CI validates it; a merged planning PR, rather than a review alone, creates immutable Gate 1 evidence. Human collaborators and authorized user agents may edit the proposal, while Workers remain topology-free and have no planning authority.

Amendments reuse the same GitHub path: bounded discovery evidence can seed an amendment PR, but a human or authorized user agent edits and approves the revised unmet DAG.

## Related

- [[wiki/sources/2026-07-22_adr-003-dag-as-gated-checkpoint|ADR-003: DAG as Gated Checkpoint]]
- [[wiki/sources/2026-07-22_adr-024-amend-dag-resolution-action|ADR-024: Amend-DAG]]
