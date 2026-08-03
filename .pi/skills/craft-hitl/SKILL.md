---
name: craft-hitl
description: >-
  Phase-gate execution workflow for non-trivial HITL tasks. Same full flow
  (C→R→A→F→T→S) as /craft, but includes mandatory human-in-the-loop gating at
  TODO(human) seams during Render.
---

# CRAFTS HITL Workflow Skill — Repository Builder

## When to use

This is a Repository Builder skill for local work in this repository. It is not the Pool Worker `craft-pool` workflow.

Invoke this skill for issue slices explicitly labeled **HITL implementation** or **HITL design/review**, or any task where the PRD reserves a critical decision for human judgment.

This inherits the local `/craft` contracts for original acceptance-criteria plumbing, fresh `local-craft-*` children, schema-valid phase artifacts, model diversity, child-owned implementation, and elevated-risk policy. Its only behavioral override is the mandatory human seam inside **R — Render**. When C emits any `security_triggers`, it performs the same fresh independent `local-craft-security` plan review with `security-and-hardening` before any Render edit; an empty list keeps the current HITL flow. The agent scaffolds to the seam, pauses for human input, then resumes and completes the remaining phases.

If the task is unambiguously autonomous, use `/craft` instead.

## Overview

CRAFTS is a sequential phase-gate workflow. Do not plan or execute phases in parallel per feature or issue; finish the current phase before moving to the next one.

In HITL mode, the Render phase contains a mandatory pause. The human owns the critical decision-bearing logic; the agent owns everything before and after it.

Delegate each phase through Pi's `subagent` tool to its matching local project agent, one call at a time. When C emits any `security_triggers`, additionally invoke the independent `local-craft-security` plan-security checkpoint after the planner and before R. Wait for each report before proceeding, fixing blockers, or asking for clarification. Do not run CRAFTS subagents in parallel.

When exact per-spawn model selection is available, the R/F builder and A evaluator must run on different models, with the evaluator at equal or higher capability. For example, if `local-craft-builder` runs on one frontier/coding-capable model, spawn `local-craft-evaluator` on a different peer model rather than the same model family. If exact model diversity and capability ordering cannot be enforced, fail closed.

| Phase | Subagent | Purpose |
| --- | --- | --- |
| C — Conceptualize | `local-craft-planner` | Planning, TDD strategy, scope, risks, and gates |
| R — Render | `local-craft-builder` | Test-driven implementation and build guidance |
| A — Assess | `local-craft-evaluator` | Simplification, correctness, type safety, and verification review |
| F — Fix | `local-craft-builder` | Minimal fixes for blocking findings |
| T — Tighten | `local-craft-security` | Security and trust-boundary review |
| S — Sharpen | `local-craft-sharpener` | Durable documentation, product alignment, and retained learnings |

## Full Flow: C → R → A → F → T → S

### C — Conceptualize

Define scope, test cases, implementation plan, and risks before coding.

Use the Pi `subagent` tool with `agent: "local-craft-planner"` for this phase when available. Pass the user request, relevant issue slice, repository constraints, and any known HITL seams. Use its report as the gate artifact before moving to Render.

- Read the relevant issue slice or user request thoroughly.
- Identify whether the work is AFK (agent can complete solo) or HITL (requires human at a critical seam).
- If multi-step, create or update a todo list before coding.
- Treat provided acceptance criteria as ground truth; author them only when none were supplied.
- Produce: scope boundary, acceptance-criteria alignment, file list, test strategy, and risk assessment. Emit the schema-defined closed-vocabulary `security_triggers` list. If non-empty, use existing trust-boundary and test-strategy fields for the concrete plan and obtain a passing fresh plan-security review before Render; do not assign a risk score or create separate asset/abuse-case fields.
- Stop here if the plan is unclear — do not proceed to Render with ambiguous requirements.

### R — Render (Test-Drive with HITL Gate)

Write failing tests first, then implement up to the critical seam, pause for human input, then complete implementation and refactor.

Use the Pi `subagent` tool with `agent: "local-craft-builder"` for this phase when available. Pass the C artifact and original acceptance criteria; for triggered work, also pass the required, passing plan-security report. The fresh local builder child edits the assigned workspace and returns the R artifact; the conductor only validates and gates. When exact model selection is available, choose a model with a different evaluator available at equal or higher capability. Do not implement in the parent conductor context.

#### Red
Write the failing test from the plan. If you can't write it, return to Conceptualize.

#### Green (up to the seam)
Write the minimum implementation to pass, **stopping before the critical human-owned logic**.

- Scaffold all surrounding code: types, tests, structure, and wiring.
- Leave exactly one `TODO(human)` marker at the critical decision point. Make it specific:
  - Bad: `// TODO(human): implement this`
  - Good: `// TODO(human): decide the threshold for todo_filled — should we require marker removal, or is a substantive edit sufficient?`
- Summarize the context: tell the human what has been scaffolded, what decision is needed, and what the acceptance criteria are.
- **Stop processing.** Do not write code past the `TODO(human)` marker.

#### Human fill
Wait for the human to implement the critical logic and signal readiness.

#### Green (after the seam)
After the human responds:

1. **Read the human's implementation** carefully. Do not assume it matches what you would have written.
2. **Run the tests** scoped to the changed area. Fix any test failures caused by integration mismatches.
3. Complete any remaining implementation to make the full test suite pass.
4. **Remove the `TODO(human)` marker** once the seam is filled and verified.

#### Refactor
Clean up without breaking green. Repeat for each test case.

- Run lint, type checks, and format when all tests pass.
- If the slice requires a `TODO(human)` seam, pause for human input before continuing.

### A — Assess

Review the diff for quality, reuse, efficiency, and type correctness.

Use the Pi `subagent` tool with `agent: "local-craft-evaluator"` for this phase when available. Pass the task goal, original acceptance criteria, CRAFTS plan, changed files, verification evidence, and the model used for `local-craft-builder`. Require the schema-valid A artifact. When exact model selection is available, use a different evaluator model at equal or higher capability than the builder; fail closed if exact selection cannot enforce this. Treat blocking findings as inputs to Fix.

- Check for duplicated logic, missed edge cases, unclear naming.
- Verify type safety if applicable.
- Verify the HITL seam integrates cleanly with the surrounding agent-scaffolded code.
- Flag anything that should be fixed before proceeding.
- The local journal bounds the A→F→A loop to one Fix plus one re-Assessment. A second blocking Assessment requires a persisted human decision.

### F — Fix

Address blocking issues from Assess or Tighten. Re-run quality checks.

Use the Pi `subagent` tool with `agent: "local-craft-builder"` for this phase when available. Pass only the blocking findings and relevant context so fixes remain minimal and scoped.

- High and medium severity first.
- Disagree with a finding? Document why instead of blindly fixing.

### T — Tighten

Run the security-hardening review for the diff and fix findings.

Use the Pi `subagent` tool with `agent: "local-craft-security"` for this phase when available. Pass the task goal, changed files, verification output, and any trust boundaries identified during Conceptualize or Render.

- Scan for injection risks, unsafe defaults, exposed secrets.
- Verify boundary enforcement where applicable.
- Pay special attention to the HITL seam: does the human-owned logic introduce any trust boundary issues?
- Use `security-and-hardening` proportionately. For triggered work, account for every C trust boundary and return blocking findings to F before repeating T.
- The local journal bounds the T→F→T loop to one Fix plus one re-Tighten. A second blocking Tighten requires a persisted human decision.

### S — Sharpen

Capture durable lessons, gotchas, process updates, and any documentation changes so repo docs stay evergreen and aligned to code.

Use the Pi `subagent` tool with `agent: "local-craft-sharpener"` for this phase. Pass the final diff summary, verification results, issue status, and any conventions or gotchas discovered during the task. The child remains read-only and returns a schema-valid documentation-change artifact; the conductor applies only path-validated documentation changes.

- Document the HITL seam and the rationale for the human-owned decision.
- When Tighten identifies a reusable security finding, record one disposition: `guidance-update`, `owned-follow-up`, or `documented-non-generalizable`.
- Update relevant domain instructions and wiki/raw documentation without recording transient noise.

## Lite Flow: R → S

For simple HITL tasks (config changes, single-file fixes with one obvious seam):

1. **R — Render:** scaffold to the seam, pause for human input, complete, verify.
2. **S — Sharpen:** capture any doc updates and commit.

Start lite, then escalate to full if the task grows, the seam is more complex than expected, or a non-empty `security_triggers` list requires C's plan-security checkpoint.

## Escalation Rules

- Start lite. If the task grows beyond a single file or the HITL seam has ripple effects, escalate to full.
- Never skip Assess and Tighten on code that crosses a trust boundary or handles user input.
- If a task starts as HITL but the human defers the decision back to the agent, switch to `/craft` and complete autonomously.
- If Render reaches a `TODO(human)` seam, pause for human input before continuing.
