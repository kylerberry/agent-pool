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

1. **Load sources.** Read `docs/goal-prompt.md`, `docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md`, `docs/raw/adr/orchestrator/ADR-034-domain-discovery-before-implementation.md`, `docs/raw/specs/schemas/domain-map-approval.schema.json`, and `docs/raw/specs/templates/domain-map-approval.json`. If a domain map exists, read `docs/raw/context/initial-domain-map.md`.
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

3. **Mechanical validation.** Before writing the artifact, verify:
   - `nodes` is an array and every node has `id`, `intent`, `change_spec`, `acceptance_criteria`, `depends_on`.
   - All `id` values are unique.
   - Every `depends_on` entry references an existing `id`.
   - The graph has no cycles (run a topological sort; fail closed on cycle).
   - At least one node has `depends_on.length === 0` (ready nodes exist).
4. **Write the durable artifact.** Save the validated DAG to `docs/raw/plans/proposed-build-dag.json`.
5. **Stop for Kyler approval.** Present the artifact path, node count, ready nodes, the ADR-034 gate status, and whether a valid domain-map approval record exists. Do not begin implementation until Kyler approves.
6. **On approval: reserve one ready node.** A node is ready when all of its `depends_on` nodes have passed in the local ledger. By default, reserve and execute exactly one node per `/goal` invocation, then stop and report the new frontier.

## ADR-034 domain-map approval seam

Before any feature-implementation node may begin, the durable artifact must include a completed domain-map node and a valid, separate domain-map approval record must exist at:

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

A template is at `docs/raw/specs/templates/domain-map-approval.json`. Kyler fills it in and moves it to `docs/raw/plans/domain-map-approval.json`; the repository does not ship an approved record.

## Ledger and dispatcher

The local conductor uses `node .pi/scripts/goal-dispatcher.mjs` to durably track Repository Builder node lifecycles. This is local development bookkeeping, not Pool Worker runtime state or authority. The dispatcher stores its state under `.pi/goal-runs/<runId>/ledger.json` (which is gitignored) and exposes the commands `init`, `status`, `resume`, `start`, `retry`, `record-phase`, `complete`, `emit-candidate`, and `migrate-plan`. It freezes the approved DAG SHA-256 on `init` and rejects any operation when the approved plan drifts.

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

A repeated `start` resumes the same active attempt instead of allocating another. `resume` reports its next required phase. Every phase result is written beneath `.pi/goal-runs/<run-id>/incoming/` as a non-symlinked JSON file and persisted before continuing; `record-phase` rejects arbitrary external paths:

```bash
node .pi/scripts/goal-dispatcher.mjs record-phase <node-id> <attempt-id> <C|R|A|F|T|S> <artifact.json>
```

A Tighten finding follows the CRAFTS repair loop without overwriting evidence:

```text
T needs_fix -> F -> T recheck
```

The dispatcher stores later F/T artifacts as immutable revisions (`F-2.json`, `T-2.json`, and so on), retains every revision in `phase_history`, and treats only the latest revision as the active gate result. It never advances to S while the latest T is non-passing.

After all required phases pass:

```bash
node .pi/scripts/goal-dispatcher.mjs complete <node-id> <attempt-id> passed
```

`complete ... passed` fails unless the full selected flow has schema-valid persisted evidence and the latest required gate revisions pass. Failed or escalated attempts use the same command with `failed` or `escalated` and retain their phase artifacts. After explicit human authorization, retry a terminal attempt with:

```bash
node .pi/scripts/goal-dispatcher.mjs retry <node-id> <approved-by> "<reason>"
```

Retry preserves the terminal attempt and completion record, records approver/reason/time, and creates the next numbered attempt. It is local Repository Builder workflow state only.

### Approved-plan migration (`migrate-plan`)

When an approved plan needs a bounded post-approval amendment, use:

```bash
node .pi/scripts/goal-dispatcher.mjs migrate-plan <old-plan.json> <new-plan.json> <approval.json>
```

All three arguments are repository-relative paths. `old-plan.json` is the snapshot that was frozen in the ledger. `new-plan.json` must be the dispatcher's canonical plan path (`docs/raw/plans/proposed-build-dag.json`) and must match the detached approved hash. `approval.json` is a separate, human-signed envelope.

The approval envelope must contain exactly:

```json
{
  "schema_version": 1,
  "run_id": "<run-id>",
  "expected_old_plan_sha256": "<sha256-of-old-plan-bytes>",
  "approved_new_plan_sha256": "<sha256-of-new-plan-bytes>",
  "approver": "<identifier>",
  "approved_at": "<ISO-8601-timestamp>",
  "approval_context": "<human-readable rationale>"
}
```

Mechanical checks performed by the dispatcher:

- The envelope is owned by the effective user and is not group- or world-writable.
- `run_id` matches the dispatcher's run ID.
- `expected_old_plan_sha256` equals both the SHA-256 of `old-plan.json` and the ledger's `frozen_plan_sha`.
- `approved_new_plan_sha256` equals the SHA-256 of `new-plan.json`.
- The new plan's approval timestamp is later than the old plan's approval timestamp.
- No active attempt or workspace writer exists.
- Node IDs, intents, change specs, and dependency topology are unchanged.
- Completed (`passed`) nodes keep their existing acceptance criteria verbatim.
- Pending nodes may only receive append-only additions to acceptance criteria; existing criteria must not be altered or removed.
- Completed node definitions and phase evidence are preserved and re-verified before activation.

On success the dispatcher writes content-addressed audit objects (old plan, new plan, approval envelope, evidence manifest, amendment record) under `.pi/goal-runs/<runId>/migrations/objects/`, updates the ledger's `frozen_plan_sha` atomically, and appends the amendment. Re-running the same command with identical inputs is a verified idempotent replay that returns the existing amendment index. The ledger is never deleted or reinitialized to resolve approved-plan drift.

## Eval telemetry

The project-local `.pi/extensions/eval-telemetry/` extension auto-loads in each `local-craft-*` child after `/reload`. It associates a child only from `PI_SUBAGENT_CHILD*`, the active workspace-writer guard, and the frozen goal ledger; prompt text is never used for identity.

For every phase it records launcher/runtime metadata, actual provider/model usage and cost from Pi's finalized assistant messages, prompt/system hashes, tool names and outcomes, session references, configured versions, and Git state. It never persists prompt text, assistant text, tool arguments/results, environment variables, changed-file names, or credentials. Raw local telemetry remains under the ignored path:

```text
.pi/goal-runs/<run-id>/telemetry/sessions/<session-key>/
```

Telemetry errors degrade collection and appear in `/eval-telemetry-status`; they do not block model work or roll back node completion. On completion, the dispatcher writes a sanitized record under `eval-candidates/` labelled `telemetry-only`. Formal routing eligibility remains false until a fixture has independently reviewed pre-existing tests and is replayed bare with production-equivalent tools at the required N=3.

## Dispatching a ready node

The `/goal` session is the local ledger conductor. It keeps only the approved node payload and compact persisted phase artifacts in active use, and invokes each phase as a separate foreground Pi `subagent` call with `context: "fresh"`:

- pass the node's `intent`, `change_spec`, and original `acceptance_criteria` as the immutable unit payload;
- use the project-local `local-craft-*` agents named in `.pi/skills/craft/SKILL.md`;
- call exactly one phase at a time and wait for its schema-valid JSON result;
- persist the result through `record-phase` before invoking the next phase;
- use model grants pinned exactly to `.pi/model-routing.bootstrap.json` and `.pi/settings.json`;
- obey the phase tool grants in `.pi/skills/craft/SKILL.md`.

Preflight before spawning:

1. Confirm the pinned models exist in `.pi/runtime-versions.json` `allowedModels`.
2. Confirm `.pi/model-routing.bootstrap.json` has `failClosedOnUnavailableExplicitModel: true`.
3. Run `node .pi/scripts/validate-goal-plan.mjs` from the repository root; it must validate the approved DAG topology and the domain-map approval SHA-256.
4. Run `node .pi/scripts/goal-dispatcher.mjs init`, then `resume`. If an attempt is active, continue its reported `next_phase`; otherwise confirm the target is in the ready frontier.
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
