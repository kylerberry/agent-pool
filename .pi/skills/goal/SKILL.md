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

The file is written once, then frozen until Kyler approves or amends it.

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
6. **On approval: dispatch ready nodes only.** A node is ready when all of its `depends_on` nodes are completed. For each ready node, launch a **fresh local CRAFTS slice** as described below.

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

## Dispatching a ready node

A Pi skill cannot create an OS process. To run a node, launch a **fresh Pi conductor session** (a new subagent/session context) with:

- the node's `intent`, `change_spec`, and `acceptance_criteria` as the unit payload;
- the project-local `craft` skill loaded;
- `pi-subagents` available;
- model grants pinned exactly to `.pi/model-routing.bootstrap.json` and `.pi/settings.json`;
- tool grants matching the phase table in `.pi/skills/craft/SKILL.md`.

Preflight before spawning:

1. Confirm the pinned models exist in `.pi/runtime-versions.json` `allowedModels`.
2. Confirm `.pi/model-routing.bootstrap.json` has `failClosedOnUnavailableExplicitModel: true`.
3. Confirm the previous dependency nodes have passed (their phase artifacts are present and `status === "passed"`).
4. If this is a feature-implementation node, confirm the ADR-034 domain-map approval seam passes (record exists, is schema-valid, and the map SHA-256 matches).

If any preflight check fails, fail closed and report to Kyler.

## Parallelism rule

Default execution is **serial**: finish one node's full CRAFTS flow before starting the next. Independent approved slices may run in parallel **only in isolated worktrees** (separate git worktrees with independent working trees and contexts). Never run multiple writer phases against the same working tree simultaneously.

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
