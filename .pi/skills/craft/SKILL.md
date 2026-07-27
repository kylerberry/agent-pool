---
name: craft
description: >-
  Local CRAFTS phase-gate execution workflow for building this repository in Pi.
  Use the full flow (C→R→A→F→T→S) for business logic, multi-file work, and
  domain-boundary changes. Use the lite flow (R→S) for config, scaffolding, and
  simple single-file fixes. This is the project-local skill; the future remote
  craft-pool runtime uses the separate `craft-pool` skill.
---

# CRAFTS Workflow Skill — Project-Local

## Local-only scope

This skill runs CRAFTS **locally inside this repository's Pi environment**, not inside the future remote `craft-pool` supervisor runtime. The remote runtime uses its explicitly loaded `craft-pool` skill from `packages/worker-harness/skills/craft-pool/SKILL.md` with orchestrator-owned decomposition, audit-trail emission, and pool-grade model diversity. The local skill is for the implementation slices Kyler approves and runs here.

Local phase agents are named `local-craft-*` and are configured in `.pi/settings.json` (`subagents.agentOverrides`) and `.pi/agents/local-craft-*.md`. They are intentionally separate from the remote `craft-*` phase agents so changes to the local workflow never silently redefine remote `craft-pool` routing.

## When to use

Invoke this skill for every non-trivial task. Use the **full flow** for business logic, multi-file work, and anything crossing domain boundaries. Use the **lite flow** for config, scaffolding, and simple single-file fixes.

Start lite, then escalate to full if the task grows.

## Overview

CRAFTS is a sequential phase-gate workflow. Do not plan or execute phases in parallel per feature or issue; finish the current phase before moving to the next one.

A local implementation slice starts as a **fresh Pi conductor session** — a new context that owns the unit request and original acceptance criteria. The conductor spawns exactly one phase subagent at a time via `pi-subagents`, waits for its structured artifact, then routes to the next phase, fixes blockers, or asks Kyler for clarification. Do not run CRAFTS subagents in parallel, and do not let one phase subagent spawn another.

Pass **compact structured artifacts** between phases, not working transcripts. The artifact handed forward is also the durable record. Each phase artifact must be valid JSON where a schema is available; prose-only completion fails the phase.

When exact per-spawn model selection is available, the R/F builder and A evaluator must run on different but equal-capability models. In this local workflow the pins below make that automatic; if the runtime cannot honor the exact pinned model, the slice fails closed and escalates to Kyler rather than silently substituting.

## Local model pins

These pins are exact for local slices. Fallback models that would violate them are not configured; if a pinned model is unavailable the slice fails closed.

| CRAFTS phase | Subagent type | Model | Phase role |
| --- | --- | --- | --- |
| C — Conceptualize | `local-craft-planner` | `openai-codex/gpt-5.6-sol` | read-only planning |
| R — Render | `local-craft-builder` | `moonshot/kimi-k2.7-code` | writer |
| F — Fix | `local-craft-builder` | `moonshot/kimi-k2.7-code` | writer |
| A — Assess | `local-craft-evaluator` | `openai-codex/gpt-5.6-sol` | read-only review |
| T — Tighten | `local-craft-security` | `openai-codex/gpt-5.6-terra` | read-only security review |
| S — Sharpen | `local-craft-sharpener` | `openai-codex/gpt-5.6-terra` | read-only docs reviewer |

Routing is enforced in `.pi/settings.json` (`subagents.agentOverrides`) and `.pi/model-routing.bootstrap.json`. Preflight each slice against `.pi/runtime-versions.json` before spawning.

## Fresh-context conductor discipline

A normal Pi skill cannot create an OS process. The local slice therefore runs in a **fresh Pi conductor session** (a new conversation/subagent context) launched by the parent conductor with the unit payload. That session:

1. Loads `docs/raw/specs/schemas/crafts-phase-artifact.schema.json` as the `outputSchema` for each phase child so `structured_output` is available.
2. Spawns phase subagents sequentially with `pi-subagents`, passing only the compact artifact from the previous phase plus the original acceptance criteria.
3. Validates each artifact before persistence or handoff; invalid or prose-only output fails the phase.
4. Never forwards a phase's full transcript to the next phase.
5. Uses one foreground Pi `subagent` call per phase (`agent: "local-craft-*"`, `context: "fresh"`); phases are not combined into a parallel chain.
6. Writes the returned JSON artifact to a temporary file, validates it through `node .pi/scripts/goal-dispatcher.mjs record-phase <node> <attempt> <phase> <file>`, and only then forwards its compact contents.

## Tool grants and read-only phases

| Phase | Write? | Allowed tool scope |
| --- | --- | --- |
| C — Conceptualize | no | read, grep, find, ls, graphify |
| R — Render | yes | read, write, edit, grep, find, ls, bash, graphify |
| F — Fix | yes | read, write, edit, grep, find, ls, bash, graphify |
| A — Assess | no | read, grep, find, ls, graphify |
| T — Tighten | no | read, grep, find, ls, graphify |
| S — Sharpen | no | read, grep, find, ls, graphify |

### Read-only phases and the S-phase limitation

C, A, T, and S are read-only by tool grant: they receive only `read`, `grep`, `find`, `ls`, and `graphify`, with no `bash`, `edit`, or `write`. This is capability-layer enforcement through the agent tool allowlist, not a prompt-only scope. R and F are the only local phase agents that may mutate the workspace.

Because standard Pi tool allowlists cannot path-scope `edit`/`write` to documentation and instruction-file paths, local S cannot be safely granted write tools. Local S therefore remains read-only and returns a documentation-change artifact (the S-phase JSON payload) describing the exact changes to apply to `docs/**`, domain `AGENTS.md`, and pointer-only `CLAUDE.md`. The fresh local conductor validates every requested path and applies only those changes; if a requested path is outside the allowed documentation/instruction-file scope, the conductor rejects it and asks Kyler.

## Acceptance criteria provenance

Acceptance criteria may either be **provided as input** (by a human, an issue slice, or an upstream orchestrator that decomposed the work) or **absent**, in which case C authors them.

- **If criteria are provided:** treat them as ground truth. C does **not** re-author or reinterpret them — it plans and builds the test suite *against* them. Provided criteria are the independent reference used later in the Assess phase.
- **If no criteria are provided:** C authors acceptance criteria as part of Conceptualize, as before.

This distinction matters for review independence: when criteria have an author upstream of C, the Assess phase can check both the build *and* C's test suite against that original reference, catching interpretation drift. When C authors the criteria itself, no such upstream reference exists — Assess can only check internal consistency.

## Full Flow: C → R → A → F → T → S

### C — Conceptualize

Define scope, test cases, implementation plan, and risks before coding.

Use the Pi `subagent` tool with `agent: "local-craft-planner"` and `context: "fresh"` for this phase. Pass the user request, relevant issue slice, repository constraints, any provided acceptance criteria, and any known blockers or ambiguities. Use its report as the gate artifact before moving to Render.

- Read the relevant issue slice or user request thoroughly.
- **If acceptance criteria were provided as input, treat them as ground truth — do not re-author. If none were provided, produce them.**
- Determine task complexity, scope boundaries, and whether the plan is fully actionable within the current context.
- If multi-step, create or update a todo list before coding.
- Produce: scope boundary, acceptance criteria (authored only if not provided), file list, test strategy, and risk assessment.
- Stop here if the plan is unclear — do not proceed to Render with ambiguous requirements.

### R — Render (Test-Drive)

Write failing tests first, then implement the minimum change to pass, then refactor.

Use the Pi `subagent` tool with `agent: "local-craft-builder"` and `context: "fresh"` for this phase. Pass the C phase report and the original acceptance criteria. The fresh local builder child edits the assigned workspace and returns the R-phase artifact; the local conductor only gates phases and validates/forwards artifacts. The conductor does not implement in the parent context.

- **Red:** write the failing test from the plan. If you can't write it, return to Conceptualize.
- **Green:** write the minimum implementation to pass. No more.
- **Refactor:** clean up without breaking green. Repeat for each test case.
- Run lint, type checks, and format when all tests pass.

### A — Assess

Review the diff for quality, reuse, efficiency, and type correctness.

Use the Pi `subagent` tool with `agent: "local-craft-evaluator"` and `context: "fresh"` for this phase. Pass the task goal, **the original acceptance criteria (the provided/upstream version when one exists, not only C's derived plan)**, the CRAFTS plan, changed files, verification evidence, and the model used for `local-craft-builder`. The evaluator must run on a different model at equal or higher capability; if the runtime cannot honor this, fail closed and escalate. Treat blocking findings as inputs to Fix.

- **When original criteria are available, check the test suite itself against them — not just the code against the tests.** A suite that faithfully passes but misencodes the criteria is a blocking finding.
- Check for duplicated logic, missed edge cases, unclear naming.
- Verify type safety if applicable.
- Flag anything that should be fixed before proceeding.

### F — Fix

Address blocking issues from Assess. Re-run quality checks.

Use the Pi `subagent` tool with `agent: "local-craft-builder"` and `context: "fresh"` for this phase. Pass only the blocking findings and relevant context so fixes remain minimal and scoped. The fresh local builder child edits the assigned workspace and returns the F-phase artifact; the conductor validates and forwards.

- High and medium severity first.
- Disagree with a finding? Document why instead of blindly fixing.

### T — Tighten

Run the security-hardening review for the diff and fix findings.

Use the Pi `subagent` tool with `agent: "local-craft-security"` and `context: "fresh"` for this phase. Pass the task goal, changed files, verification output, and any trust boundaries identified during Conceptualize or Render.

- Scan for injection risks, unsafe defaults, exposed secrets.
- Verify boundary enforcement where applicable.

### S — Sharpen

Capture durable lessons, gotchas, process updates, and any documentation changes so repo docs stay evergreen and aligned to code.

Use the Pi `subagent` tool with `agent: "local-craft-sharpener"` and `context: "fresh"` for this phase. Pass the final diff summary, verification results, issue status, and any conventions or gotchas discovered during the task.

- Local S is read-only. It returns a documentation-change artifact describing the exact updates to apply to relevant domain docs (README, ADR, CLAUDE.md, PRD, ISSUES) and any conventions or gotchas discovered during the task.
- The fresh local conductor validates that every requested path is under `docs/` or a domain `AGENTS.md`/`CLAUDE.md`, then applies only those changes. It rejects paths outside that scope and asks Kyler.
- Commit and push if applicable.

## Lite Flow: R → S

For config, scaffolding, and simple single-file fixes:

1. **R — Render:** make the smallest correct change. Use `local-craft-builder`. Write or update tests if the codebase already has them.
2. **S — Sharpen:** capture any doc updates and commit. Use `local-craft-sharpener`; the conductor applies the returned documentation-change artifact after path validation.

## Escalation Rules

- Start lite. If the task grows beyond a single file or requires domain reasoning, escalate to full.
- Never skip Assess and Tighten on code that crosses a trust boundary or handles user input.

---

## Changelog (v3)

- Renamed local phase agents to `local-craft-*` and updated `.pi/settings.json` so the local `/craft` workflow does not silently redefine remote `craft-pool` phase-agent routing.
- Made local C, A, T, and S read-only by tool grant (no `bash`, `edit`, or `write`). Local R and F remain the only implementation writers.
- Documented the S-phase limitation: standard Pi tool allowlists cannot path-scope `edit`/`write`, so local S returns a documentation-change artifact and the fresh local conductor applies docs/instruction-file changes after validating paths.
- Clarified R/F wording: the fresh local builder child edits the assigned workspace and returns the phase artifact; the conductor gates phases and validates/forwards artifacts.
- Kept v2 acceptance-criteria provenance and v1 standalone compatibility.
