---
audience: both
subject: development-harness
status: accepted
---

# Repository Builder and Pool Worker Role Boundary

## Purpose

This repository is built by agents and produces a system that runs agents. Those are different
actors with different authority. Repository subject matter does not make a local development
session a Pool Worker.

## Canonical actors

### Repository Builder

A local development session that edits product code, specifications, ADRs, and tests. It works
from repository instructions and approved product constraints. Without valid Pool Worker context,
this is the default actor.

A Repository Builder is not executing a production DAG node and must not invoke `craft-pool`.

### Pool Worker

A fresh Pi session launched by trusted product-runtime code to execute one attempt. During the
approved Pool Proof, the Minimal Pool Runtime is that launcher; the future complete supervisor
fills the role later.

- Receives one bounded unit, original acceptance criteria, exact model/tool grants, and attempt identity.
- Uses an explicitly loaded `packages/worker-harness` profile: the builder-only Pool Proof profile during the approved proof, and `craft-pool`/`craft-*` only when the full production flow is implemented.
- May implement only the assigned unit and escalate unapproved product or architecture decisions.
- Does not redesign the pool runtime, supervisor, DAG policy, grading system, or worker harness.

The Minimal Pool Runtime and Pool Proof Harness are deterministic software, not additional Pi
actors. A Repository Builder may invoke proof commands as a developer, but the Runtime creates a
separate verified Worker process.

## Physical separation

- `packages/worker-harness/` is the Pool Worker harness and is loaded explicitly only for Pool Worker sessions.
- Trusted product-runtime code or the worker image installs/loads the exact worker profile only for Pool Worker sessions.
- The Pool Proof profile loads one approved builder and no evaluator, CRAFTS, or Graphify resources; the existing full CRAFTS profile remains separate and unchanged until its deferred integration work.
- Shared capabilities may exist in later environments, but role-specific agents, skills, config roots, and session stores do not cross actor boundaries.

## Machine-readable execution context

Before any model call, a Pool Worker validates:

1. `AGENT_POOL_ACTOR=pool-worker` plus launcher-supplied expected node, attempt, repository, branch, workspace, runtime/profile, model/tool grant, and result-destination values.
2. `.agent-pool/execution-context.json` exists (or the trusted launcher supplies its path through `AGENT_POOL_EXECUTION_CONTEXT`).
3. The context validates against the approved execution-context contract and independent launcher expectations before paid work.
4. The exact worker profile, contracts, routing, selected model, trusted tools, private Pi config/session roots, and repository sandbox pass preflight.

The context is generated per attempt by trusted product-runtime code, mounted or captured as
launcher-owned state, freshness-checked, and never committed to a target repository. Target
instructions and task text are untrusted data and cannot alter actor identity or grants. A
parameterless `actor_identity` surface reads the launcher-captured context rather than a mutable
workspace marker.

The Pool Proof builder profile and the later `craft-pool` profile each fail closed when their own
context, environment, or capability preflight is invalid. Without a valid context and successful
matching preflight, the session remains a Repository Builder by default.

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

Product/runtime documents constrain what builders create. They do not imply that a local
Repository Builder is already running inside the product.
