---
title: Local Repository Builder /goal Workflow — Canonical Authority
type: source
tags: [source, workflow, governance, goal, repository-builder]
created: 2026-08-16
updated: 2026-08-16
sources:
  - docs/raw/context/local-repository-builder-workflow.md
---

# Local Repository Builder /goal Workflow

## Summary

Canonical authority for local `/goal` plan governance, superseding the detached exact-hash
local-authorization regime. A plan authorizes the local ledger by being structurally valid with
one human-attributed `approval` object; the ledger freezes its SHA and rejects drift.

## Key rules

- **Generic authorization:** any structurally valid approved plan may `init`/`archive-reset`. No
  hard-coded canonical plans; no detached candidate/source/scope/archive approval.
- **Verified file boundary:** plan, conditional domain map/approval, and optional sidecar are
  read via one FD-based root-containment reader (no final/ancestor symlinks, regular files,
  size bounds, post-open identity checks).
- **Locked snapshots:** every mutating dispatcher operation validates criteria and compares the
  frozen SHA against one verified plan snapshot taken under the ledger lock.
- **Conditional domain-map gate:** `domain_boundaries_changed: true` activates ADR-034
  approval/hash validation; `false`/absent performs no map reads; non-boolean fails closed.
- **Optional exceptional sidecar:** `scope_review_path` is optional and covers only exceptional
  ADR-035 node IDs with concise rationales.
- **Direct attempt-scoped decisions:** exhausted reviews require
  `{attempt_id, target: {type, name, revision}}` decisions; legacy `bound_to` records stay
  immutable and resolve only unambiguously.
- **Explicit continue-ready:** default `/goal` stays one-node; sequential continuation through
  ready nodes is opt-in with per-iteration guard release, fresh frontier, and full preflight.
- **Archive-reset:** all validation before mutation; archived ledger verified (regular,
  non-symlinked, digest match) before active-run removal.

## Related

- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]
- [[wiki/sources/2026-08-13_functional-pool-deployment|Functional Pool Deployment]]
- [[wiki/sources/2026-04-13_adr-034-domain-discovery-before-implementation|ADR-034]]

## Raw source

- `docs/raw/context/local-repository-builder-workflow.md`
