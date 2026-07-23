---
name: craft
description: >-
  Phase-gate execution workflow for non-trivial tasks. Use the full flow
  (C→R→A→F→T→S) for business logic, multi-file work, and domain-boundary
  changes. Use the lite flow (R→S) for config, scaffolding, and simple
  single-file fixes.
---

# CRAFTS Workflow Skill

## When to use

Invoke this skill for every non-trivial task. Use the **full flow** for business logic, multi-file work, and anything crossing domain boundaries. Use the **lite flow** for config, scaffolding, and simple single-file fixes.

Start lite, then escalate to full if the task grows.

## Overview

CRAFTS is a sequential phase-gate workflow. Do not plan or execute phases in parallel per feature or issue; finish the current phase before moving to the next one.

Each phase should be delegated to its matching global subagent when the AgentSpawn tool is available. Spawn exactly one phase subagent at a time, wait for its report, then either proceed to the next phase, fix blockers, or ask the user for clarification. Do not run CRAFTS subagents in parallel.

When exact per-spawn model selection is available, the R/F builder and A evaluator must run on different but equal-capability models. For example, if `craft-builder` runs on one frontier/coding-capable model, spawn `craft-evaluator` on a different peer model rather than the same model family. If the runtime only supports tier aliases, keep both at `medium` and explicitly note that exact model diversity could not be enforced in the phase report.

## Acceptance criteria provenance

Acceptance criteria may either be **provided as input** (by a human, an issue slice, or an upstream orchestrator that decomposed the work) or **absent**, in which case C authors them.

- **If criteria are provided:** treat them as ground truth. C does **not** re-author or reinterpret them — it plans and builds the test suite *against* them. Provided criteria are the independent reference used later in the Assess phase.
- **If no criteria are provided:** C authors acceptance criteria as part of Conceptualize, as before.

This distinction matters for review independence: when criteria have an author upstream of C, the Assess phase can check both the build *and* C's test suite against that original reference, catching interpretation drift. When C authors the criteria itself, no such upstream reference exists — Assess can only check internal consistency.

## Full Flow: C → R → A → F → T → S

### C — Conceptualize

Define scope, test cases, implementation plan, and risks before coding.

Use AgentSpawn with `subagent_type: "craft-planner"` for this phase when available. Pass the user request, relevant issue slice, repository constraints, any provided acceptance criteria, and any known blockers or ambiguities. Use its report as the gate artifact before moving to Render.

- Read the relevant issue slice or user request thoroughly.
- **If acceptance criteria were provided as input, treat them as ground truth — do not re-author. If none were provided, produce them.**
- Determine task complexity, scope boundaries, and whether the plan is fully actionable within the current context.
- If multi-step, create or update a todo list before coding.
- Produce: scope boundary, acceptance criteria (authored only if not provided), file list, test strategy, and risk assessment.
- Stop here if the plan is unclear — do not proceed to Render with ambiguous requirements.

### R — Render (Test-Drive)

Write failing tests first, then implement the minimum change to pass, then refactor.

Use AgentSpawn with `subagent_type: "craft-builder"` for this phase when available. Pass the C phase report and ask for test-first implementation guidance. When exact model selection is available, choose a model that has an equal-capability but different-model peer available for the later `craft-evaluator` spawn. Execute the implementation sequentially in the parent context after reviewing the subagent report.

- **Red:** write the failing test from the plan. If you can't write it, return to Conceptualize.
- **Green:** write the minimum implementation to pass. No more.
- **Refactor:** clean up without breaking green. Repeat for each test case.
- Run lint, type checks, and format when all tests pass.

### A — Assess

Review the diff for quality, reuse, efficiency, and type correctness.

Use AgentSpawn with `subagent_type: "craft-evaluator"` for this phase when available. Pass the task goal, **the original acceptance criteria (the provided/upstream version when one exists, not only C's derived plan)**, the CRAFTS plan, changed files, verification evidence, and the model used for `craft-builder`. When exact model selection is available, use a different but equal-capability model from the builder; if only tier aliases are available, keep `medium` and record the limitation. Treat blocking findings as inputs to Fix.

- **When original criteria are available, check the test suite itself against them — not just the code against the tests.** A suite that faithfully passes but misencodes the criteria is a blocking finding.
- Check for duplicated logic, missed edge cases, unclear naming.
- Verify type safety if applicable.
- Flag anything that should be fixed before proceeding.

### F — Fix

Address blocking issues from Assess. Re-run quality checks.

Use AgentSpawn with `subagent_type: "craft-builder"` for this phase when available. Pass only the blocking findings and relevant context so fixes remain minimal and scoped.

- High and medium severity first.
- Disagree with a finding? Document why instead of blindly fixing.

### T — Tighten

Run the security-hardening review for the diff and fix findings.

Use AgentSpawn with `subagent_type: "craft-security"` for this phase when available. Pass the task goal, changed files, verification output, and any trust boundaries identified during Conceptualize or Render.

- Scan for injection risks, unsafe defaults, exposed secrets.
- Verify boundary enforcement where applicable.

### S — Sharpen

Capture durable lessons, gotchas, process updates, and any documentation changes so repo docs stay evergreen and aligned to code.

Use AgentSpawn with `subagent_type: "craft-sharpener"` for this phase when available. Pass the final diff summary, verification results, issue status, and any conventions or gotchas discovered during the task.

- Update the relevant domain docs (README, ADR, CLAUDE.md, PRD, ISSUES) with patterns established, gotchas discovered, conventions set during this task.
- Commit and push if applicable.

## Lite Flow: R → S

For config, scaffolding, and simple single-file fixes:

1. **R — Render:** make the smallest correct change. Use `craft-builder` when AgentSpawn is available. Write or update tests if the codebase already has them.
2. **S — Sharpen:** capture any doc updates and commit. Use `craft-sharpener` when AgentSpawn is available.

## Escalation Rules

- Start lite. If the task grows beyond a single file or requires domain reasoning, escalate to full.
- Never skip Assess and Tighten on code that crosses a trust boundary or handles user input.

---

## Changelog (v2)

- Added **Acceptance criteria provenance** section: C authors criteria only when none are provided as input; provided criteria are treated as ground truth.
- **A phase** now receives the original/upstream criteria (when present) and is instructed to check the test suite against them, not just the code against the tests — closing the review-independence gap when criteria have an author upstream of C.
- Kept fully standalone-compatible: with no upstream criteria and no orchestrator, behavior is identical to v1.
