---
audience: both
subject: development-harness
status: accepted
---

# Repository Builder and Pool Worker Role Boundary

## Purpose

This repository is built by agents and produces a system that runs agents. Those are different actors with different authority. Confusing them causes a Repository Builder to behave as if the pool already exists, or a Pool Worker to redesign the product it was assigned to use.

## Canonical actors

### Repository Builder

A Pi session developing the agent-pool product in this repository.

- Edits product code, specifications, ADRs, tests, and development-harness configuration.
- Uses `.pi/`, the local `/goal` and `craft` skills, and `local-craft-*` phase agents.
- May make implementation decisions inside approved product constraints.
- Is not executing a production DAG node and must not invoke `craft-pool`.

This is the default actor whenever no valid pool-worker execution context exists.

### Pool Worker

A fresh Pi session launched by the completed supervisor to execute one node attempt.

- Receives one bounded unit, original acceptance criteria, exact model/tool grants, and attempt identity.
- Uses the explicitly loaded `packages/worker-harness` package and its `craft-pool`/`craft-*` resources.
- May implement only the assigned unit and escalate unapproved product or architecture decisions.
- Does not redesign the supervisor, DAG policy, grading system, or worker harness.

## Physical separation

- `.pi/` is the Repository Builder harness and is auto-discovered locally.
- `packages/worker-harness/` is the Pool Worker harness and is not listed in local `.pi/settings.json`.
- The supervisor or worker image explicitly installs/loads the worker package only for pool-worker sessions.
- Shared capabilities such as Graphify may exist in both environments, but role-specific agents and skills do not.

## Machine-readable execution context

Before any model call, a Pool Worker validates:

1. `AGENT_POOL_ACTOR=pool-worker` plus launcher-supplied expected node, attempt, repository, and branch values.
2. `.agent-pool/execution-context.json` exists (or the trusted launcher supplies its path through `AGENT_POOL_EXECUTION_CONTEXT`).
3. The file validates against `docs/raw/specs/schemas/pool-worker-execution-context.schema.json`.
4. Required worker-harness agents, contracts, routing, models, and tools pass preflight.

The marker is generated per attempt by the trusted supervisor, mounted or protected as launcher-owned state, bound to the expected identity/target environment values, freshness-checked, and never committed to a target repository. It is a role/launch invariant, not an authentication or sandbox boundary.

`craft-pool` fails closed when the marker, environment, or capability preflight is invalid. Without a valid marker, the session remains a Repository Builder by default.

## Documentation classification

Documentation may declare:

```yaml
audience: repository-builder | pool-worker | both
subject: development-harness | product-runtime
```

Directory defaults:

- `docs/raw/specs/` and `docs/raw/adr/orchestrator/`: subject is `product-runtime`; primary audience is `repository-builder` unless explicitly marked otherwise.
- `docs/raw/context/` and `docs/wiki/`: mixed; add metadata when actor ambiguity is plausible.
- `packages/worker-harness/`: audience is `pool-worker`, subject is `product-runtime`.
- `.pi/`: audience is `repository-builder`, subject is `development-harness`.

Product/runtime documents constrain what builders create. They do not imply that a local Repository Builder is already running inside the product.
