---
name: craft-pool
description: >-
  Agent-pool CRAFTS workflow. Use when CRAFTS runs as the intra-node execution
  method inside the orchestrator's supervisor pipeline: acceptance criteria
  arrive from an approved upstream unit payload, review independence and model diversity
  are enforced, and every phase emits audit-trail records. Full flow
  (C→R→A→F→T→S) for business logic, multi-file work, and domain-boundary
  changes; lite flow (R→S) for config, scaffolding, and simple single-file
  fixes. This is a complete, self-contained skill — it does not depend on any
  other CRAFTS skill.
---

# CRAFTS Workflow — Agent-Pool Skill

## When to use

This skill runs CRAFTS as the internal execution method of a **DAG node** inside the orchestrator's supervisor pipeline. It assumes an orchestrator exists above it that supplied an approved node payload originating from decomposition or direct-task intake. Use the **full flow** for business logic, multi-file work, and anything crossing domain boundaries; use the **lite flow** for config, scaffolding, and simple single-file fixes. Start lite, escalate to full if the task grows.

This is a standalone skill. It intentionally duplicates general CRAFTS phase mechanics rather than depending on another skill, so it loads and runs as one complete unit.

## Mandatory actor preflight

Before reading the unit, spawning a phase, or making any paid model call:

1. Require `AGENT_POOL_ACTOR=pool-worker` plus launcher-supplied node, attempt, repository, and branch expectations.
2. Require the per-attempt `.agent-pool/execution-context.json` marker (or `AGENT_POOL_EXECUTION_CONTEXT`).
3. Run `node ../../scripts/preflight.mjs`; preflight must bind marker identity/target to launcher expectations and reject stale markers from this skill directory, with `AGENT_POOL_WORKSPACE` set to the target workspace.
4. Continue only on exit code 0.

Missing or invalid context means this session is not a Pool Worker. Fail closed and report to the supervisor; never fall back to Repository Builder behavior. The marker is a role invariant, not an authentication or sandbox boundary.

## Core framing

- A **DAG node = one unit of work** — the atomic thing the orchestrator dispatches, grades, retries, and tracks as one audit-trail entry.
- **CRAFTS is intra-node.** The DAG expresses dependencies *between* units; CRAFTS is *how one unit gets built*. The orchestrator does not control phase flow, but it persists each validated phase artifact and consumes the final unit result; the queue remains phase-unaware.
- **The node's primary agent is the CRAFTS conductor.** The worker session running this skill spawns *every* phase — including C — as a sequential subagent, owns each phase's task payload, and gates between them. C is a **planning subagent, peer to the rest**; it plans, it does not orchestrate.
- Two sibling routing decisions: the primary routes the **process** (full vs. lite) based on C's *reported* complexity; the orchestrator's model router routes the **model** (which model per task). Phases report; the conductor routes.

## Pool guarantees (what makes this variant distinct)

These bindings are enforced in this context and are the reason this is a separate skill:

1. **Criteria always come from upstream.** Acceptance criteria are always an immutable input to the node, originating from either an approved decomposition or caller-authored direct-task submission. The payload carries its criteria origin and source identifiers. C **never** authors criteria here — it treats them as ground truth and builds the test suite against them. This gives an interpretation authored outside and above C, which is what makes the Assess phase's independence real.

2. **Enforced criteria-to-A plumbing.** The Assess phase (`craft-evaluator`) receives the node's original upstream acceptance criteria as part of its task payload, passed explicitly by the node's fresh Pi conductor session — not left to implicit child-context propagation. A model-diverse but context-coupled reviewer catches build defects, not interpretation defects; passing original criteria de-correlates the interpretations. A's mandate explicitly includes auditing C's test suite against the original criteria, not only reviewing the build against the tests. This is structural, not aspirational: because the primary agent spawns A directly (rather than A being spawned by C), the primary owns A's payload by construction and passes the original criteria in unmediated by C's interpretation.

3. **Enforced model diversity.** Exact-model selection is guaranteed available in the pool, so there is no tier-alias fallback. `craft-builder` (R/F) and `craft-evaluator` (A) MUST run on different models; the evaluator should be a tier above the builder when available and must never be lower capability. A node whose runtime cannot honor this fails closed and escalates — it does not silently proceed on same-model review.

4. **Audit-trail emission.** Every phase emits JSON validated against the bundled `../../contracts/crafts-phase-artifact.schema.json` and persisted to the orchestrator's audit trail. Invalid or prose-only output fails the phase. This feeds tier 1, tier 2, and the composite; the produced test suite remains a persisted artifact.

## Grading model

- **Tier 1 (deterministic gate):** red-state evidence (ADR-025) / tests / lint / typecheck / static analysis / coverage delta. Binary. Produced at R, re-verified after F.
- **Tier 2 (model-judged review):** `craft-evaluator` emits **criteria fit** (a hard floor gate — code that solves the wrong problem fails regardless of quality) plus a **maintainability** score. `usability` was dropped (inconsistently applicable, weakly LLM-judgeable); `regression_risk` is deferred until the code graph can feed blast-radius evidence.
- **Composite:** tier-1 pass AND tier-2 passage. Before empirical thresholds exist, criteria fit is a binary evidence gate and any blocking maintainability finding fails; numeric scores are calibration data. After calibration, ADR-009's empirical task-class threshold applies.

## Phase-diverse model rule

When exact per-spawn model selection is used, R/F and A run on different models; the evaluator should be higher capability when available and must never be lower capability than the builder. Per guarantee 3, there is no medium-tier fallback in this context; inability to enforce diversity is a fail-closed escalation, not a logged proceed.

## Full Flow: C → R → A → F → T → S

CRAFTS is a sequential phase-gate workflow. Do not run phases in parallel per unit; finish the current phase before the next. **The primary agent spawns each phase's subagent itself** — including C — passing that phase's payload directly. Spawn exactly one phase subagent at a time, wait for its report, then proceed, fix blockers, or escalate. Do not run CRAFTS subagents in parallel, and do not let one phase subagent spawn another.

**Schema enforcement.** Launch each phase with bundled `../../contracts/crafts-phase-artifact.schema.json` adapted as the Pi `outputSchema`; the child must call `structured_output`. Validate before persistence or handoff. Prose-only completion fails the phase.

**Context discipline (pass artifacts, not transcripts).** Each phase passes its structured *output* forward — C passes its plan, R passes the diff and verification evidence, A passes its findings — never its full working transcript. The next phase receives the compact artifact, not everything the prior phase read to produce it. Context stays within budget as a natural consequence of the phase-gate structure rather than a bolted-on summarizer; the phase boundaries *are* the compaction boundaries. If a single phase's own working context grows large, summarize within that phase before handing its artifact forward. (This composes with audit-trail emission: the artifact handed forward is also the record emitted per phase.)

**Failure context survives compaction (ADR-026).** A phase that fails MUST include a failure-context section in its emitted artifact: what was attempted, why it failed, and any discoveries made (edge cases, surprising codebase behavior, dead ends ruled out). Retry attempts receive the prior attempts' failure artifacts in their task payload — a retry never starts blind, and never silently repeats a documented dead end. Raw transcripts are still never injected into prompts; they are retained on disk and indexed in the audit trail (by node + attempt) as a human debugging escape hatch when the artifact wasn't enough.

| Phase | Subagent | Purpose |
| --- | --- | --- |
| C — Conceptualize | `craft-planner` | Planning, TDD strategy, scope, risks, gates (against provided criteria) |
| R — Render | `craft-builder` | Test-driven implementation and build |
| A — Assess | `craft-evaluator` | Reviews build AND test suite against original criteria; emits tier-2 score |
| F — Fix | `craft-builder` | Minimal fixes for blocking findings |
| T — Tighten | `craft-security` | Security and trust-boundary review |
| S — Sharpen | `craft-sharpener` | Durable documentation and retained learnings |

### Per-phase payload contract

The primary agent constructs each phase's payload explicitly. Pass what the phase needs and nothing more — over-passing defeats the compaction discipline; under-passing (especially A) defeats review independence.

| Phase | Receives | Must NOT receive |
| --- | --- | --- |
| C | unit request, **original acceptance criteria**, repo/branch constraints, prior failure artifacts (on retry) | — |
| R | C's plan artifact, original criteria, pinned builder model | C's working transcript |
| A | task goal, **original upstream acceptance criteria**, C's plan, changed files/diff, tier-1 evidence (incl. red-run output), builder model used | C's derived interpretation *in place of* the original criteria; the builder's transcript |
| F | **only** the blocking findings from A, plus the diff and relevant context | A's full review transcript; unrelated findings |
| T | task goal, changed files, verification output, trust boundaries identified in C or R | — |
| S | final diff summary, verification results, unit status, conventions/gotchas discovered | full phase transcripts |

On retry, every phase additionally receives prior attempts' **failure-context artifacts** (see below) — never prior transcripts.

### Per-phase tool grants (ADR-029)

Tools are pulled on demand, not pre-injected: each phase gets its payload plus tools installed in the container (`graphify` code graph, grep/LSP) and repo-resident knowledge (LLM wiki, skills). Grants are scoped by phase:

| Phase | Grants |
| --- | --- |
| C | read, grep, graphify |
| R / F | read, **write**, grep, graphify |
| A | read, grep, graphify — **no write** |
| T | read, grep, graphify, security tooling |
| S | read, grep, **write scoped to docs/wiki** |

A's write denial is load-bearing: an evaluator able to edit the code it judges is a gate that can rewrite its own exam — the capability-layer analog of builder/evaluator model diversity. Consult the wiki's generated directory index before assuming a page does or doesn't exist.

### C — Conceptualize

Define scope, test strategy, plan, and risks before coding, **against the provided upstream criteria**.

Use `craft-planner` when available. Pass the unit request, relevant issue slice, repository constraints, and the **provided acceptance criteria**. Use its report as the gate artifact before Render.

- Read the unit request and provided criteria thoroughly.
- **Treat the provided acceptance criteria as ground truth. Do not re-author or reinterpret them.** Build the test strategy to encode them.
- Assess and **report** complexity and scope boundaries. C reports; the primary agent decides full-vs-lite from that report.
- If multi-step, create/update a todo list before coding.
- Produce: scope boundary, test strategy against criteria, file list, risk assessment.
- Stop if the plan is unclear — do not proceed to Render with ambiguous requirements; escalate for clarification.

### R — Render (Test-Drive)

Write failing tests first, implement the minimum to pass, then refactor.

Use `craft-builder` when available. Choose a builder model that has a different evaluator model available at equal or higher capability.

- **Red:** write the failing test from the plan and **run it against the pre-change tree to demonstrate it fails**. Capture that red-run output as tier-1 evidence (ADR-025) — a suite that cannot produce a red state is rejected mechanically. If you can't write the failing test, return to Conceptualize.
- **Green:** minimum implementation to pass. No more.
- **Refactor:** clean up without breaking green. Repeat per test case.
- Run lint, type checks, format when green — this is the tier-1 gate.

### A — Assess

Review the diff AND the test suite against the original criteria.

Use `craft-evaluator` when available, on a different model that is preferably higher capability and never lower capability than the builder. Pass the task goal, the **original upstream acceptance criteria**, the plan, changed files, verification evidence, and the builder model used.

- **Check the test suite against the original criteria — not just the code against the tests.** A suite that passes but misencodes the criteria is a blocking finding.
- Check for duplicated logic, missed edge cases, unclear naming, type safety.
- Emit the tier-2 rubric score.
- Flag anything to fix before proceeding.

### F — Fix

Address blocking findings from Assess; re-run quality checks (re-verify tier 1).

Use `craft-builder` when available. Pass only the blocking findings and relevant context so fixes stay minimal and scoped.

- High and medium severity first.
- Disagree with a finding? Document why instead of blindly fixing.

### T — Tighten

Security-hardening review of the diff; fix findings.

Use `craft-security` when available. Pass the task goal, changed files, verification output, and trust boundaries identified during C or R.

- Scan for injection risks, unsafe defaults, exposed secrets.
- Verify boundary enforcement where applicable.

### S — Sharpen

Capture durable lessons, gotchas, and documentation changes.

Use `craft-sharpener` when available. Pass the final diff summary, verification results, unit status, and conventions/gotchas discovered.

- Update relevant domain docs (README, ADR, CLAUDE.md, PRD, ISSUES).
- Commit and push if applicable.

## Lite Flow: R → S

For config, scaffolding, and simple single-file fixes:

1. **R — Render:** smallest correct change. Use `craft-builder` when available. Write/update tests if the codebase has them (tier-1 gate still applies).
2. **S — Sharpen:** capture doc updates and commit. Use `craft-sharpener` when available.

## Escalation

Retry and budget ceilings are owned by the orchestrator (fixed global retry ceiling; per-node and per-DAG budget caps), not by CRAFTS. When a unit exhausts retries or blows budget, CRAFTS surfaces the failure with its audit records; the orchestrator handles freeze/escalation and the human resolution actions (retry / manual fix / cancel branch / override-with-logged-reason / amend-DAG). Retry ceilings are tracked per failure class — `logic` (this node's own defect) vs. `integration` (re-failed at re-verification because a sibling changed the head) — so a node is never escalated as defective for losing integration races (ADR-023).

Never skip Assess and Tighten on code that crosses a trust boundary or handles user input.
