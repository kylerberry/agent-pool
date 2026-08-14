---
name: goal
description: >-
  Local /goal skill. Reads docs/goal-prompt.md, proposes an ADR-018 flat build
  DAG, validates it mechanically, writes a durable proposed artifact, stops for
  Kyler approval, validates the ADR-034 domain-map approval record and SHA-256,
  and then permits only ready nodes to begin fresh local CRAFTS slices.
---

# /goal — Local Build-DAG Skill

## Local-only scope

This skill is for **building this repository locally in Pi**. It is not the future remote `craft-pool` runtime's decomposition pipeline. It produces a human-approved plan that the local conductor dispatches as fresh CRAFTS slices.

## Invocation

Type `/goal` in the conductor session. The skill reads `docs/goal-prompt.md` (the canonical project objective and constraints) and any already-approved `docs/raw/plans/*.json` artifacts.

## Output

A durable proposed build-DAG artifact at:

```
docs/raw/plans/proposed-build-dag.json
```

The file is written once, then frozen until Kyler approves or amends it. If it already contains valid approval metadata, do not regenerate it: validate it, initialize/resume the ledger, and execute only the reserved node.

## Steps

1. **Load sources.** Read `docs/goal-prompt.md`, `docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md`, `docs/raw/adr/orchestrator/ADR-034-domain-discovery-before-implementation.md`, `docs/raw/adr/orchestrator/ADR-035-minimal-coherent-dag-nodes.md`, `docs/raw/adr/orchestrator/ADR-036-discovered-work-and-dag-amendment.md`, `docs/raw/adr/orchestrator/ADR-039-agent-assisted-probe-execution.md`, `docs/raw/specs/functional-pool-deployment.md` when present, `docs/raw/specs/schemas/domain-map-approval.schema.json`, and `docs/raw/specs/templates/domain-map-approval.json`. If a domain map exists, read `docs/raw/context/initial-domain-map.md`.
2. **Propose a flat DAG.** Emit a JSON object with a `nodes` array. Each node is a flat ADR-018 node:

```json
{
  "id": "domain-map",
  "intent": "Human-approved bounded-domain map",
  "change_spec": "Derive candidate domains, define purpose/state/interfaces/invariants, produce dependency map, create src/domains/<domain>/AGENTS.md and pointer CLAUDE.md",
  "acceptance_criteria": ["..."],
  "depends_on": []
}
```

3. **Slice review and mechanical validation.** Before writing the proposed artifact, review each candidate against ADR-035: it must express one independently verifiable outcome, a primary acceptance oracle, bounded seam, explicit non-goals, and genuine dependencies. Split independently acceptable outcomes; record a concise Gate-1 rationale for any inseparable cross-domain, multi-contract, or multi-suite change. Current ADR-018 proposal JSON stays five-field: do not invent a runtime field for that review metadata until the planned validator/schema work is approved.

   Then verify:
   - The top level contains `schema_version: 1` and `nodes`; `kind` and `source` are optional.
   - `nodes` is an array and every node has exactly `id`, `intent`, `change_spec`, `acceptance_criteria`, `depends_on`.
   - All `id` values are unique.
   - Every `depends_on` entry references an existing `id`.
   - The graph has no cycles (run a topological sort; fail closed on cycle).
   - At least one node has `depends_on.length === 0` (ready nodes exist).
4. **Write the durable proposal.** Save it to `docs/raw/plans/proposed-build-dag.json`. This pre-approval structural check is intentionally separate from `goal-plan.mjs`, whose full validator requires human approval metadata.
5. **Stop for Kyler approval.** Present the artifact path, node count, ready nodes, the ADR-034 gate status, and whether a valid domain-map approval record exists. Do not begin implementation until Kyler approves. For the functional-pool deployment candidate, generic approval notes are insufficient: `validate-goal-plan.mjs` requires a detached record conforming to `functional-pool-deployment-approval.schema.json` and exact candidate/source/scope-review/completed-plan-archive bytes. On valid approval, add the required canonical-plan `approval` object and run `node .pi/scripts/validate-goal-plan.mjs`; the approved artifact must pass the full schema and hash validation.
6. **On approval: reserve one ready node.** A node is ready when all of its `depends_on` nodes have passed in the local ledger. By default, reserve and execute exactly one node per `/goal` invocation, then stop and report the new frontier.

## ADR-034 domain-map approval seam

Before any feature-implementation node may begin, the approved domain map and its valid, separate approval record must exist at:

```
docs/raw/plans/domain-map-approval.json
```

The record conforms to `docs/raw/specs/schemas/domain-map-approval.schema.json` and contains:

| Field | Meaning |
| --- | --- |
| `map_path` | Repository-relative path to `docs/raw/context/initial-domain-map.md` |
| `map_sha256` | SHA-256 hex digest of the approved map file contents |
| `approved_by` | Human approver identifier (e.g., `kyler`) |
| `approved_at` | ISO 8601 timestamp of approval |

Mechanical check before feature-slice DAG generation/dispatch:

1. `docs/raw/context/initial-domain-map.md` exists.
2. `docs/raw/plans/domain-map-approval.json` exists and validates against the schema.
3. The SHA-256 of `docs/raw/context/initial-domain-map.md` equals `map_sha256`.
4. `approved_by` and `approved_at` are present and non-empty.

If any check fails, block all feature slices and ask Kyler to approve the domain map first. Do not invent domains opportunistically.

A template is at `docs/raw/specs/templates/domain-map-approval.json`. This repository currently contains an approved record at `docs/raw/plans/domain-map-approval.json`; do not replace it unless Kyler approves the changed map and records its new SHA-256. DAG dependency status remains a separate ledger concern—for the current approved DAG, `domain-scaffolding` carries the map-approval acceptance criterion and unlocks its dependent feature nodes.

## Ledger and dispatcher

The local conductor uses `node .pi/scripts/goal-dispatcher.mjs` to durably track Repository Builder node lifecycles. This is local development bookkeeping, not Pool Worker runtime state or authority. The dispatcher stores its state under `.pi/goal-runs/<runId>/ledger.json` (which is gitignored) and exposes the commands `init`, `status`, `resume`, `start`, `retry`, `record-phase`, `record-checkpoint`, `record-decision`, `complete`, `emit-candidate`, `upgrade-ledger`, and `archive-reset`. It freezes the approved DAG SHA-256 on `init` and rejects any operation when the approved plan drifts.

Before the first dispatch, run:

```bash
node .pi/scripts/goal-dispatcher.mjs init
```

Then query the frontier with:

```bash
node .pi/scripts/goal-dispatcher.mjs status
```

And reserve exactly one ready node with its selected flow:

```bash
node .pi/scripts/goal-dispatcher.mjs start [node-id] [C-R-A-F-T-S|R-S]
```

A repeated `start` resumes the same active attempt instead of allocating another. `resume` reports its next required action. The conductor first stages each returned JSON artifact as a non-symlinked file inside `.pi/goal-runs/<run-id>/` (by convention under `incoming/`), then records it:

```bash
node .pi/scripts/goal-dispatcher.mjs record-phase <node-id> <attempt-id> <C|R|A|F|T|S> <artifact.json>
```

`record-phase` rejects arbitrary external paths, validates the staged input, and writes the canonical append-only copy beneath `.pi/goal-runs/<run-id>/phases/` before updating the ledger and next action. `record-checkpoint` and `record-decision` use the same staging rule and persist canonical copies under `checkpoints/` and `decisions/`.

### Elevated-risk plan-security checkpoint

When a C artifact declares non-empty `security_triggers`, the full flow requires a fresh independent `local-craft-security` plan-security checkpoint before Render. Record it with:

```bash
node .pi/scripts/goal-dispatcher.mjs record-checkpoint <node-id> <attempt-id> <checkpoint.json>
```

The checkpoint JSON must contain `kind: "plan-security"`, `status: "pass"|"needs-replan"`, the reviewed C artifact SHA-256 and revision, the triggers, and findings for `needs-replan`. A `needs-replan` result allows one C repair and one re-review; a second blocking critical/high result requires a persisted human decision with only `stop-and-rescope` allowed.

### Bounded review loops and human decisions

A `needs_fix` Assess or Tighten result routes through Fix and one re-review. A second blocking result for the same phase requires a human decision bound to the review artifact hash. Record it with:

```bash
node .pi/scripts/goal-dispatcher.mjs record-decision <node-id> <attempt-id> <decision.json>
```

The decision JSON must contain `kind: "human-decision"`, `bound_to` (the review or checkpoint artifact SHA-256), `outcome: "defer-and-proceed"|"stop-and-rescope"`, `decided_by`, and `reason`. `stop-and-rescope` terminates the attempt as escalated. The current journal permits explicitly human-attributed `defer-and-proceed` only for an exhausted A/T `needs_fix` review or an exhausted plan-security checkpoint whose unresolved findings are below high severity, and only within the existing criteria. Unresolved critical/high plan-security findings permit only `stop-and-rescope`.

### Completion and retry

After all required phases pass:

```bash
node .pi/scripts/goal-dispatcher.mjs complete <node-id> <attempt-id> passed
```

`complete ... passed` fails unless the full selected flow has schema-valid persisted evidence and the latest required gate revisions pass. Failed or escalated attempts use the same command with `failed` or `escalated` and retain their phase artifacts. After explicit human authorization, retry a terminal attempt with:

```bash
node .pi/scripts/goal-dispatcher.mjs retry <node-id> <approved-by> "<reason>"
```

Retry preserves the terminal attempt and completion record, records approver/reason/time, and creates the next numbered attempt. It is local Repository Builder workflow state only.

### Approved-plan drift recovery (`archive-reset`)

When the approved plan changes materially, do not patch the ledger in place. After Kyler approves the new plan and its SHA-256, archive the existing run and create a fresh ledger:

```bash
node .pi/scripts/goal-dispatcher.mjs archive-reset <current-plan-sha256> <approved-by> "<reason>"
```

This validates and hashes the current approved plan, then performs a backup-first reset under the ledger lock: it copies the whole run beneath `.pi/goal-runs/.archived/`, removes the active run, and initializes a fresh ledger with approver, reason, old hash, and archive path recorded in `reset_from`. This sequence is intentionally recoverable but is not one atomic filesystem transaction; after an interruption, inspect the archived copy and active run before retrying.

### Ledger upgrade (`upgrade-ledger`)

If an existing v1 ledger is present, normalize it to v2 before use:

```bash
node .pi/scripts/goal-dispatcher.mjs upgrade-ledger --dry-run
node .pi/scripts/goal-dispatcher.mjs upgrade-ledger
```

The upgrade preserves every node, attempt, phase artifact, and historical amendment, creates an exact-byte backup named with the old ledger hash, and atomically writes the v2 ledger. Active attempts remain active and resume at the action derived from their recorded artifacts.

## Eval telemetry

The project-local `.pi/extensions/eval-telemetry/` extension auto-loads in each `local-craft-*` child after `/reload`. It associates a child only from `PI_SUBAGENT_CHILD*`, the active workspace-writer guard, and the dispatcher-written `next_action`; prompt text is never used for identity.

For every phase it records launcher/runtime metadata, actual provider/model usage and cost from Pi's finalized assistant messages, prompt/system hashes, tool names and outcomes, session references, configured versions, and Git state. It never persists prompt text, assistant text, tool arguments/results, environment variables, changed-file names, or credentials. Raw local telemetry remains under the ignored path:

```text
.pi/goal-runs/<run-id>/telemetry/sessions/<session-key>/
```

Telemetry errors degrade collection and appear in `/eval-telemetry-status`; they do not block model work or roll back node completion. On completion, the dispatcher writes a sanitized record under `eval-candidates/` labelled `telemetry-only`. Formal routing eligibility remains false until a fixture has independently reviewed pre-existing tests and is replayed bare with production-equivalent tools at the required N=3.

## Dispatching a ready node

The `/goal` session is the local ledger conductor. It keeps only the approved node payload and compact persisted phase artifacts in active use, and invokes each phase as a separate foreground Pi `subagent` call with `context: "fresh"`:

- pass the node's `intent`, `change_spec`, and original `acceptance_criteria` as the immutable unit payload;
- use the project-local `local-craft-*` agents named in `.pi/skills/craft/SKILL.md`;
- call exactly one phase at a time and wait for its structured artifact;
- persist the result through `record-phase` before invoking the next phase;
- for triggered work, persist the plan-security checkpoint through `record-checkpoint` before Render;
- for exhausted review loops, persist a human decision through `record-decision` before proceeding;
- use model grants pinned exactly to `.pi/model-routing.bootstrap.json` and `.pi/settings.json`;
- obey the phase tool grants in `.pi/skills/craft/SKILL.md`.

Preflight before spawning:

1. Confirm the pinned models exist in `.pi/runtime-versions.json` `allowedModels`.
2. Confirm `.pi/model-routing.bootstrap.json` has `failClosedOnUnavailableExplicitModel: true`.
3. Run `node .pi/scripts/validate-goal-plan.mjs` from the repository root; it must validate the approved DAG topology and the domain-map approval SHA-256.
4. Run `node .pi/scripts/goal-dispatcher.mjs init`, then `resume`. If an attempt is active, continue its reported `next_action`; otherwise confirm the target is in the ready frontier.
5. Confirm dependency nodes are `passed` in the ledger and their completion records and required phase artifacts exist.
6. If this is a feature-implementation node, confirm the ADR-034 domain-map approval seam passes (record exists, is schema-valid, and the map SHA-256 matches).

If any preflight check fails, fail closed and report to Kyler.

## Parallelism rule

Default execution is **serial and one-shot**: finish one node's full CRAFTS flow, persist completion, print the newly derived frontier, and stop the `/goal` invocation. Independent approved slices may run in parallel only after an explicit user request and only in distinct Git worktrees, each with a unique `GOAL_RUN_ID` and its own conductor context. A workspace-wide writer guard prevents different run IDs from writing concurrently in one worktree. Before parallel launch, verify `git rev-parse --show-toplevel` differs for every writer workspace. Never run multiple writer phases against the same working tree.

## Domain-map approval record

When Kyler approves the domain map, create the separate approval record at `docs/raw/plans/domain-map-approval.json` conforming to `docs/raw/specs/schemas/domain-map-approval.schema.json`. The record binds the approved map file to its SHA-256 and is mechanically validated before any feature-slice DAG generation/dispatch. A template is at `docs/raw/specs/templates/domain-map-approval.json`.

## DAG approval

When Kyler approves the proposed DAG, append an `approval` field to `docs/raw/plans/proposed-build-dag.json`:

```json
{
  "approval": {
    "approved_by": "kyler",
    "approved_at": "2026-04-13T00:00:00Z",
    "notes": "..."
  }
}
```

A node is not dispatched until the DAG artifact is approved **and** the ADR-034 domain-map approval seam is satisfied.

## Failure handling

If mechanical validation fails, do not write the artifact. Return the validation errors, fix them, and re-run. If a dispatched node fails its CRAFTS flow, record the failure-context artifact, freeze downstream nodes, and ask Kyler whether to retry, amend the DAG, or cancel.
