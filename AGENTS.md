# Repository Agent Instructions

## Working Style

- Clarify ambiguity that blocks a correct implementation; do not silently choose between materially different interpretations.
- State consequential assumptions and tradeoffs.
- Prefer the smallest solution that satisfies the request.
- Do not add speculative features, abstractions, configurability, or impossible-case handling.
- Touch only requested code and match existing style.
- Remove imports, variables, functions, and files made obsolete by your change.
- Mention unrelated problems without fixing them unless asked.
- Every changed line should trace to the request.

## Current Actor: Repository Builder

Unless a trusted `.agent-pool/execution-context.json` marker identifies this session as a Pool Worker and the worker-harness preflight passes, you are a **Repository Builder** implementing the agent-pool product. Repository subject matter does not make you a member of the pool.

Repository Builders work directly from repository specifications and tests. Do not invoke `craft-pool` or behave as though the supervisor, queue, or pool already exists. Trusted product-runtime code explicitly loads runtime-only Pool Worker resources from `packages/worker-harness/`.

See `docs/raw/context/repository-builder-vs-pool-worker.md`.

## Project Purpose

This repository implements an agent-pool and supervisor-orchestrator system: a warm pool of coding agents plus a deterministic controller that decomposes free-form work into gated, auditable units, dispatches them, grades outcomes, and produces reviewable GitHub artifacts.

## Documentation

Before non-trivial work, read `docs/AGENTS.md`, `docs/wiki/index.md`, and relevant wiki pages. Read relevant raw sources for binding requirements or conflict resolution. Raw sources win over the wiki; flag contradictions and update the wiki when appropriate.

Do not duplicate canonical docs into the repository root. Project knowledge lives in `docs/`.

For meaningful durable changes, add one activity-log fragment under `docs/wiki/log/entries/`; do not append feature-branch entries directly to `docs/wiki/log.md`.

## Instruction Files

`AGENTS.md` is canonical at every scope. A sibling `CLAUDE.md` must contain only:

```md
@AGENTS.md
```

Update `AGENTS.md`; never duplicate its instructions into `CLAUDE.md`.

## Project Workflows

- For code-relationship questions, query a current, provenance-checked `graphify-out/graph.json` before broad scanning. Verify graph claims in source and tests. Use canonical project docs—not generated Graphify wiki output—for prose knowledge and decisions.
- Use `pi-subagents` when defining or coordinating project agents and chains.

## Source Layout

Product domain logic belongs under `src/domains/<domain>/`. Harness and adapter code may live in its owning package but must depend on domains through narrow public interfaces.

Before editing a domain, read its local `AGENTS.md`. Every domain requires canonical `AGENTS.md` and pointer-only `CLAUDE.md`.

Keep domain instructions and affected documentation current when implementation establishes durable knowledge. Record canonical requirements or decisions under `docs/raw/` first; omit transient implementation noise.

## Verification

Follow the lanes and evidence rules in `docs/raw/context/test-governance.md`. Use `npm run test:all` for deterministic aggregate evidence and `npm run test:docker` when non-skipping Docker evidence is required.

## Architecture Changes

Read relevant ADRs before changing architecture, runtime, persistence, orchestration semantics, model routing, grading, retry policy, storage, or integration boundaries.

Current anchors:

- `docs/wiki/index.md`
- `docs/raw/specs/orchestrator-spec.md`
- `docs/raw/specs/crafts-phase-artifact-contract.md`
- `docs/raw/adr/orchestrator/`

## Terminology discipline

Use the repository’s canonical terms exactly. Do not rename, paraphrase, or invent nouns for components, roles, configuration, or boundaries.

When documentation leaves a seam unspecified:
1. describe the missing data or behavior in existing terms;
2. do not propose a named abstraction unless implementation requires one;
3. label every inferred concept explicitly as a proposal;
4. prefer a concrete data-flow sentence over architectural shorthand.

Never turn adjectives such as “reviewed,” “trusted,” or “configured” into new actors or components such as “operator,” “profile,” “registry,” or “selector” unless the repository defines them.
