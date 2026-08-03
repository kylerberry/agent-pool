# Handoff: `crafts-grading-flow` attempt-1 (open decision gate)

**Date:** 2026-08-03
**Session:** Claude Code (Repository Builder)
**Status:** RESOLVED 2026-08-03. `stop-and-rescope` recorded, node escalated, plan amended to `0579607f…df524` adding upstream `attempt-provenance-store`. See `docs/wiki/log/entries/2026-08-03-crafts-grading-flow-rescope.md`. Retained below as the record of why.

**Original status:** Attempt active, blocked on an open human-decision gate. Nothing committed. Tree clean at `8392385`.

## Where it stopped and why

`node .pi/scripts/goal-dispatcher.mjs resume` returns:

```json
{"node_id":"crafts-grading-flow","attempt_id":"crafts-grading-flow-attempt-1",
 "flow":"C-R-A-F-T-S","next_action":{"decision":"87148e6b607bd209bcfc94af93fbe9abc89270d33a1d6e179ef4f133b3836364"}}
```

Two plan-security rounds both returned `needs-replan`, so `nextAction` (`.pi/scripts/goal-journal.mjs:203-211`) requires a human decision bound to the latest checkpoint hash. Only two outcomes exist:

- **`defer-and-proceed` — illegal here.** `validateDecision` (`goal-journal.mjs:423-426`) rejects it when the bound plan-security checkpoint carries `critical`/`high` findings. Checkpoint 2 carries two `high` (PS2-1, PS2-2).
- **`stop-and-rescope` — the only accepted outcome.**

A third C revision is also unavailable: the replan loop is capped at `psCount < 2`.

The decision was deliberately NOT recorded by the agent — `decided_by` is a human field and fabricating it would defeat the gate.

## Journaled artifacts (all schema-valid, dispatcher-accepted)

| Artifact | Path | sha256 |
| --- | --- | --- |
| C rev 1 | `phases/crafts-grading-flow/crafts-grading-flow-attempt-1/C.json` | `afd02b45…d0f6` |
| plan-security 1 | `checkpoints/crafts-grading-flow/crafts-grading-flow-attempt-1/plan-security-1.json` | `28e58e87…50f6` |
| C rev 2 | `phases/crafts-grading-flow/crafts-grading-flow-attempt-1/C-2.json` | `53d5202d…f15a` |
| plan-security 2 | `checkpoints/crafts-grading-flow/crafts-grading-flow-attempt-1/plan-security-2.json` | `87148e6b…6364` |

Working copies of the two security reports in narrative form are under `.pi/goal-runs/default/incoming/crafts-grading-flow-plan-security-{1,2}.json`.

## The two blocking findings

Both are **scope-shaped, not plan-quality-shaped**. The plan itself is sound.

### PS2-1 (high) — append-only key is wrong

C rev 2 specified a DB-level `UNIQUE(attempt_id, phase)` constraint for the phase-artifact store. This repository's own journal disproves it: `controller-ready-frontier-{F,F-2,F-3,F-4}` and `{T,T-2,T-3,T-4}` all share `attempt_id=controller-ready-frontier-attempt-1` with an identical `phase`. F and T legitimately repeat within one attempt.

Consequence: the second F artifact is rejected at the storage constraint, so a `needs_fix` T and its subsequent passing T cannot both persist — **directly defeating acceptance criterion 5**.

Fix: re-key to `UNIQUE(attempt_id, phase, revision)` with store-assigned monotonic revision inside the insert transaction, or `UNIQUE(attempt_id, phase, content_hash)`. Express immutability as "no revision is ever updated or deleted".

### PS2-2 (high) — remedy with no producer

C rev 2's fix for evaluator independence depends on a persisted routing decision keyed by `attempt_id`. Verified against source: no `routing_decisions` table in `src/domains/orchestration/sqlite-store.ts`, zero grep hits for `routing` in orchestration, `RoutingDecision` is a transient return of `selectForRole`/`selectBuilderEvaluatorPair` with no `attempt_id` association, and no model-routing file appears in `planned_files`. The compared field is also wrong — `RoutingDecision` exposes `selectedModel` (`model-router.ts:61-68`), not `evaluator.model_id`.

Consequence: `RoutingDecisionReader.getByAttemptId` is satisfiable only by a test fake. At runtime every Tier-2 assessment fails closed, and the pressure-release fix is to feed the reader from the artifact — restoring exactly the self-attestation the finding was raised against.

Fix: persist the builder/evaluator pair at attempt dispatch (append-only `attempt_routing_decisions` table) before any phase runs. **This is orchestration / model-routing territory, not this node's.**

### Lower findings carried forward

PS2-3 (medium, git subprocess: no size cap, no timeout, no `--` separator, leading-dash tokens accepted), PS2-4 (medium, `suite_path` realpath containment contradicts "never read the working tree" — `path-safety.ts:24-35` throws on ENOENT), PS2-5 (low, `buildRepositoryCommandEnv` contract underspecified at the new spawn site), plus PS-1 and PS-2 residuals (Tier 1 attests byte provenance, not execution; branch reachability is anti-accident, not anti-adversary, because the builder owns the branch).

## Recommended rescope

Split the two blockers into an upstream node — attempt-scoped routing-decision persistence plus the revision-keyed phase-artifact store — and have `crafts-grading-flow` depend on it, keeping artifact validation, criteria fidelity, Tier-1 provenance, sanitization, and sink provenance.

Sequence: `record-decision` (stop-and-rescope) → `complete … escalated` → `migrate-plan` with a signed approval envelope (requires no active attempt).

## Runtime deviation — important

This attempt ran in **Claude Code, not Pi**, under explicit owner override after preflight failed closed. The `local-craft-*` agents and `.pi/model-routing.bootstrap.json` pins were not the executing routing layer:

- C and plan-security ran on `anthropic/claude-opus-5`, pinned to `openai-codex/gpt-5.6-sol` and `-terra` respectively.
- `.pi/extensions/eval-telemetry` does not load in Claude Code, so `cost` is `0`/`null` rather than measured.

**These artifacts are not eligible as routing-eval fixtures.** The deviation is recorded in the `risks` array of both C revisions. Re-running in Pi would produce pinned-model provenance.

## Also worth noting

Before commit `8392385`, `record-phase` rejected a C revision with `conflicting replay for phase C` — the dispatcher modelled immutable revisions for F/T but not C, while `.pi/skills/craft/SKILL.md` says blocking plan findings "return to C". The journaling refactor resolved this: `phase_history`, `record-checkpoint`, `record-decision`, and an explicit `next_action` now model the full replan loop. Both C revisions and both checkpoints were recorded cleanly afterward.
