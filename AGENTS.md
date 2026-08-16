# Repository Agent Instructions

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## Current Actor: Repository Builder

Unless a trusted `.agent-pool/execution-context.json` marker explicitly identifies this session as a Pool Worker and the worker-harness preflight passes, you are a **Repository Builder** implementing the agent-pool product. The repository's subject matter does not make you a member of the pool.

Repository Builders use local `.pi/` resources, `/goal`, `craft`, and `local-craft-*` agents. Do not invoke `craft-pool` or behave as though the supervisor, queue, or pool already exists. Runtime-only Pool Worker resources live under `packages/worker-harness/` and are loaded explicitly by the future supervisor.

See `docs/raw/context/repository-builder-vs-pool-worker.md`.

## Project Purpose

This repository designs and implements an agent-pool / supervisor-orchestrator system: a warm pool of coding agents plus a deterministic controller that can decompose free-form work into gated, auditable units, dispatch those units to agents, grade outcomes, and deliver reviewable GitHub artifacts.

## Documentation Lookup

Before non-trivial planning or code changes:

1. Read `docs/AGENTS.md`.
2. Read `docs/wiki/index.md`.
3. Read relevant wiki pages for the task.
4. Open `docs/raw/` artifacts only when exact source wording, acceptance criteria, or ADR rationale is needed.

Do not duplicate canonical docs into the repository root. Project knowledge lives in `docs/`.

When recording durable change history, add one activity-log fragment under `docs/wiki/log/entries/`; do not append feature-branch entries directly to `docs/wiki/log.md`.

## Source Of Truth

- `docs/wiki/` = synthesized project map and working knowledge.
- `docs/raw/` = canonical source artifacts.
- If wiki conflicts with raw source, raw source wins. Flag contradiction and update wiki when appropriate.

## Agent Instruction Files

`AGENTS.md` is the canonical instruction file at every scope. A sibling `CLAUDE.md` must contain only:

```md
@AGENTS.md
```

Do not duplicate canonical instructions into `CLAUDE.md`; update the sibling `AGENTS.md` instead.

## Project Workflows

- Repository Builders use local `craft`; Pool Workers use the explicitly loaded `packages/worker-harness` `craft-pool` skill.
- For early CRAFTS planning and code-relationship questions, query `graphify-out/graph.json` when it is present and current before broad codebase scanning. It is an ignored, regenerable, code-structure aid: check its health/provenance and verify claims in source and tests. Use `docs/wiki/` and raw artifacts for prose knowledge and decisions; never treat Graphify's generated wiki as canonical.
- Use `pi-subagents` when defining or coordinating project agents and chains.

## Domain-Driven Source Layout

Application code belongs under `src/domains/<domain>/`. Each domain owns its business rules and exposes narrow interfaces; cross-domain interaction uses explicit services, events, or contracts rather than another domain's internals.

Every domain directory must contain a canonical `AGENTS.md` with actionable domain terms, invariants, interfaces, trust boundaries, verification guidance, and common footguns. Its sibling `CLAUDE.md` must contain only `@AGENTS.md`. Before editing a domain, read its local `AGENTS.md` after the repository and docs instructions.

The CRAFTS S — Sharpen phase keeps domain instructions and affected wiki pages current when work creates durable knowledge. Canonical decisions and requirements are added to `docs/raw/` first; do not record transient implementation noise.

## Test Governance

Use the explicit lanes in `docs/raw/context/test-governance.md`: `npm run test:all` for deterministic aggregate evidence, `npm run test:docker` for non-skipping Docker evidence, `npm run proof:reports:verify` for retained-report verification, and explicit Stage 1/2 commands for real-model proof only. Tests immediately clean only resources they create, never mutate tracked fixtures/configuration, and never claim isolation, persistence, or concurrency from source scans, timing sleeps, or synchronous `Promise.all`.

## Code Changes

Respect ADRs before changing architecture, runtime, persistence, orchestration semantics, model routing, grading, retry policy, storage, or integration boundaries.

Current anchors:
- `docs/wiki/index.md`
- `docs/raw/specs/orchestrator-spec.md`
- `docs/raw/specs/functional-pool-deployment.md` (proposed; exact-hash approval required before activation)
- `docs/raw/specs/crafts-phase-artifact-contract.md`
- `docs/raw/adr/orchestrator/`
