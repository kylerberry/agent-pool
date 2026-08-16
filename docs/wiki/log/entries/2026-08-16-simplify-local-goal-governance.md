---
title: Simplify local /goal governance (generic authorization, direct decisions, conditional gates)
type: activity
tags: [workflow, goal, governance, crafts]
created: 2026-08-16
node: repository-builder-workflow-simplification
---

# Simplified local Repository Builder /goal governance

Completed the `repository-builder-workflow-simplification` Render slice.

## What changed

- **Generic plan authorization:** removed `authorizeKnownCanonicalPlan` and all detached
  functional-deployment exact-hash authorization from `goal-dispatcher.mjs` and
  `validate-goal-plan.mjs`; deleted `.pi/scripts/functional-deployment-approval.mjs` and its
  executable tests. Any structurally valid plan with one human-attributed `approval` can
  initialize/archive-reset.
- **Verified repository-file boundary:** new `.pi/scripts/verified-repository-file.mjs`
  (FD-based root containment, symlink rejection, regular-file and size checks, post-open
  identity re-validation) now reads the plan, the conditionally required domain map/approval,
  and the optional ADR-035 sidecar.
- **Locked snapshots:** `recordPhase`, `init`, and `archiveReset` derive criteria, validation,
  and the frozen-SHA comparison from one verified plan snapshot acquired under the ledger lock
  (closes the validation/drift TOCTOU gap flagged by plan-security).
- **Conditional domain gate:** plan-level `domain_boundaries_changed` boolean; `true` triggers
  domain-map approval/SHA validation, `false`/absent skips it, non-boolean fails closed.
- **Optional exceptional sidecar:** `scope_review_path` is optional; sidecars cover only
  exceptional node IDs with concise rationales.
- **Direct attempt-scoped decisions:** human decisions after exhausted reviews bind
  `{attempt_id, target: {type, name, revision}}` instead of artifact hashes; legacy `bound_to`
  records remain immutable and resolve only unambiguously (fail closed).
- **Hardened archive-reset:** all validation precedes mutation; archived ledger is verified as
  a regular non-symlinked file with matching digest before active-run removal; failures leave
  active ledger and archive unchanged; `reset_from` records the verified archive digest.
- **Explicit continue-ready guidance:** `/goal` remains one-node by default; the skill documents
  the opt-in sequential continuation contract with the full stop-condition list. Dispatcher
  stays single-attempt.
- **Unactivated replacement candidate:** `docs/raw/plans/replacement-milestone-dag.candidate.json`
  contains four five-field nodes and no scope sidecar because none needs an exception; not activated.
- **Documentation authority:** new canonical authority
  `docs/raw/context/local-repository-builder-workflow.md`; goal/craft skills, goal prompt,
  ADR-034/035 amendments, schema, roadmap, and wiki updated; Pool Proof, functional deployment,
  and detached-approval artifacts marked historical/non-authoritative.

## Not changed

`docs/raw/plans/proposed-build-dag.json` (byte-identical), local ledger state, Pool
Worker/product runtime, CRAFTS phase flow and artifact contract, five-field node payload,
workspace guards, evaluator diversity, security checkpoints, review ceilings.
