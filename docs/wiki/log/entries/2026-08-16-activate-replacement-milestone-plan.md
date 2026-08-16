---
title: Activate replacement milestone plan
type: activity
tags: [plan, goal, governance, milestone]
created: 2026-08-16
node: plan-activation
---

# Activated the four-node replacement milestone plan

Kyler approved the replacement milestone candidate at 2026-08-16T13:12:39Z. The canonical plan
`docs/raw/plans/proposed-build-dag.json` now carries the embedded approval and validates at
SHA-256 `67b4d41b65840cf42ce5e851a179314d617851ee6e2ab2d613d6674eed8c0f30` (4 nodes, sole ready
root `generalize-proven-runner`, `domain_boundaries_changed: false`).

## What changed

- The superseded 17-node functional deployment plan (approved 2026-08-15; no node ever reserved
  or started) is archived byte-for-byte at
  `docs/raw/plans/superseded-functional-deployment-build-dag.json`.
- `docs/raw/plans/replacement-milestone-dag.candidate.json` is retained unchanged as the
  proposal evidence for the approved bytes.
- `docs/goal-prompt.md` §0, `docs/raw/plans/v1-roadmap.md`, the canonical workflow authority,
  and the wiki overview/index/supervisor-orchestrator/functional-pool-deployment pages now name
  the replacement milestone as the active plan and mark the 17-node phase superseded.
- Stale `exact-hash plan activation` wording in two domain `AGENTS.md` files now reads
  `approved-plan activation`; the underlying fail-closed model-eligibility policy is unchanged.
- Guard tests in `.pi/scripts/replacement-milestone-dag.test.mjs` and
  `.pi/scripts/local-governance-docs.test.mjs` pin the activation state and the archive.

## Ledger note

No local ledger exists in this worktree (`.pi/goal-runs/` absent), so no `archive-reset` was
required here. Any checkout whose ledger still freezes the superseded plan SHA
(`9f782881bee93bee888fd7cf55007b8ce8a89153d7badb9e00ea9aeef923622f`) must run `archive-reset`
with the new plan SHA before `init`/dispatch.
