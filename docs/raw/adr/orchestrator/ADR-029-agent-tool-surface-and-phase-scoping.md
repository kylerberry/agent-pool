# ADR-029: Agent Tool Surface — Pull Not Push, Scoped Per Phase

**Status:** Accepted
**Relates to:** ADR-022 (three retrieval modes), craft-pool skill (phase bindings)

## Context

ADR-022 decided *which* retrieval modes exist (grep/LSP, code graph, LLM wiki) but not how they reach an agent. Two mechanisms were possible: **push** (pre-inject retrieved context into the phase payload) or **pull** (expose tools the agent invokes on demand). Separately, "the container has the tools" implicitly grants every phase the same capabilities, which is a trust problem for the review phases.

## Decision

**Delivery is pull, not push.** A phase subagent receives three things:

1. **What its parent hands it** — the phase payload (see the per-phase contract below).
2. **Tools installed in the worker container** — `graphify` (the pluggable code-graph tool from ADR-022) plus native grep/LSP, with a skill present in the repo instructing the agent how and when to use them.
3. **Repo-resident knowledge** — the LLM wiki and any skills/docs that live in the working repo.

Rationale: the agent pays context budget only for what it actually needed. Pre-injection guesses at relevance and spends tokens on retrieval that may go unused — precisely the waste the phase-gate compaction discipline exists to avoid.

**Tool grants are scoped per phase**, declared in the skill rather than granted uniformly by the container:

| Phase | Grants |
|---|---|
| C — Conceptualize | read, grep, graphify |
| R / F — Render / Fix | read, **write**, grep, graphify |
| A — Assess | read, grep, graphify — **no write** |
| T — Tighten | read, grep, graphify, security tooling |
| S — Sharpen | write **scoped to docs/wiki**, read, grep |

A's write denial is the load-bearing one: an evaluator able to edit the code it judges is a gate that can rewrite its own exam. This is the same independence principle as builder/evaluator model diversity (craft-pool guarantee 3), enforced at the capability layer rather than the model layer.

**Provisioning requirements** (implementation-level, tracked under repo onboarding):
- The worker image installs the exact Graphify version pinned by `packages/worker-harness/config/runtime-versions.json`; its index is built per workspace and refreshed when the workspace is re-derived against a new head.
- Applicable Pi phase agents explicitly select the project `graphify` skill and receive `bash`; `inheritSkills: false` without an explicit skill is invalid for C, R/F, A, or T.
- Worker startup preflights the Graphify executable, selected skill, and phase tool grants before dispatch.
- The wiki needs a **generated directory index** the skill directs the agent to consult first—an agent only reads a page it knows exists, which is what ADR-022's "link/index navigation, not semantic search" requires in practice.
- S's docs-only write restriction must be enforced by the controller or a path-scoped Pi tool; prompt wording alone is not a security boundary.

## Consequences

Context cost scales with what the task actually needed rather than what retrieval guessed. Blast radius is contained per phase by capability, giving a concrete answer to how review phases are prevented from mutating what they review. Cost: agents must know *when* to reach for a tool — a skill-instruction quality problem rather than an architectural one, and a real dependency on tool-use reliability per model (see ADR-030).
