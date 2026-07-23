# Agent Pool

A self-hosted supervisor-orchestrator for coding agents.

It turns a free-form feature specification into a human-approved DAG of verifiable work units, dispatches ready nodes to a warm pool of coding agents, grades each result through deterministic and model-judged gates, and delivers reviewable GitHub artifacts with a durable audit trail.

> **Status:** Design complete; pre-implementation.

## Why

The project optimizes for three things:

- **Trust** — deterministic control flow, bounded model decisions, evidence gates, human approval, and auditable outcomes.
- **Pragmatism** — low-cost, self-hosted infrastructure suitable as a personal daily driver.
- **Data-backed routing** — model choice is evaluated per role rather than assumed from vendor claims.

## Architecture at a glance

```text
Free-form spec
    ↓
Decomposition model → validated flat DAG → human approval
    ↓
Deterministic supervisor controller
    ↓
Ready frontier → warm coding-agent pool → node results
    ↓
Tier 1 evidence + Tier 2 assessment → retry / escalate / continue
    ↓
Connected-component PRs and GitHub delivery
```

- The **deterministic controller** owns lifecycle state, dispatch, budgets, retries, escalation, audit records, and PR assembly.
- The **warm agent pool** executes isolated, atomic coding tasks without needing DAG awareness.
- Each DAG node uses **CRAFTS** as its intra-node execution method.
- SQLite provides the single-writer audit trail; test suites remain in the target repository and are hash-recorded for re-verification.

## Start here

Repository knowledge is wiki-first:

1. [`AGENTS.md`](AGENTS.md) — repository workflow and architectural rules.
2. [`docs/AGENTS.md`](docs/AGENTS.md) — documentation-vault rules.
3. [`docs/wiki/index.md`](docs/wiki/index.md) — synthesized project map.
4. [`docs/raw/specs/orchestrator-spec.md`](docs/raw/specs/orchestrator-spec.md) — canonical supervisor specification.
5. [`docs/raw/adr/orchestrator/`](docs/raw/adr/orchestrator/) — binding architecture decisions.

For an autonomous implementation brief, use [`docs/goal-prompt.md`](docs/goal-prompt.md).

## Project conventions

- Code will be organized by bounded domain under `src/domains/<domain>/`.
- Every domain owns `AGENTS.md`; its sibling `CLAUDE.md` contains only `@AGENTS.md`.
- `docs/raw/` contains canonical source artifacts; `docs/wiki/` is the derived, navigable knowledge base.
- Project Pi packages and skills live under `.pi/`; remote DAG-node work uses `craft-pool`.

## Key design decisions

- Free-form input is normalized into a mechanically validated flat DAG before dispatch.
- A human approves the DAG before work begins.
- Queue jobs map to individual DAG nodes, not entire features.
- Tier 1 deterministic evidence is necessary but not sufficient; Tier 2 independently assesses criteria fit and risk.
- Failed nodes freeze only dependent branches; unrelated work can continue.
- Model routing and reliability thresholds are empirically evaluated.

See [`docs/wiki/architecture/orchestrator-adr-map.md`](docs/wiki/architecture/orchestrator-adr-map.md) for the full ADR map.

## License

Not yet specified.
