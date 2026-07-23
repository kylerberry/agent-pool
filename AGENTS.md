# Repository Agent Instructions

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

- Use `craft-pool` for work executed as a remote DAG node.
- Use `graphify` for codebase architecture and relationship queries.
- Use `pi-subagents` when defining or coordinating project agents and chains.

## Domain-Driven Source Layout

Application code belongs under `src/domains/<domain>/`. Each domain owns its business rules and exposes narrow interfaces; cross-domain interaction uses explicit services, events, or contracts rather than another domain's internals.

Every domain directory must contain a canonical `AGENTS.md` with actionable domain terms, invariants, interfaces, trust boundaries, verification guidance, and common footguns. Its sibling `CLAUDE.md` must contain only `@AGENTS.md`. Before editing a domain, read its local `AGENTS.md` after the repository and docs instructions.

The CRAFTS S — Sharpen phase keeps domain instructions and affected wiki pages current when work creates durable knowledge. Canonical decisions and requirements are added to `docs/raw/` first; do not record transient implementation noise.

## Code Changes

Respect ADRs before changing architecture, runtime, persistence, orchestration semantics, model routing, grading, retry policy, storage, or integration boundaries.

Current anchors:
- `docs/wiki/index.md`
- `docs/raw/specs/orchestrator-spec.md`
- `docs/raw/specs/agent-pool-spec.md`
- `docs/raw/adr/orchestrator/`
