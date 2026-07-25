---
title: Agents Building Agents — Role Boundary Handoff
type: output
tags: [agents, pi, architecture, harness, writing]
created: 2026-04-13
updated: 2026-04-13
audience: repository-builder
subject: development-harness
sources:
  - docs/raw/context/repository-builder-vs-pool-worker.md
  - docs/raw/specs/orchestrator-spec.md
---

# Agents Building Agents

## Handoff summary

This repository has an unusual recursion problem: Pi agents are being used to build an agent pool that will itself launch Pi agents.

That creates two superficially similar but operationally different roles:

1. an agent **building the pool**;
2. an agent **running inside the pool**.

Both read the same repository. Both may use CRAFTS. Both may see references to DAGs, workers, supervisors, models, and audit artifacts. Without an explicit role boundary, a model can reasonably—but incorrectly—infer that it is already a worker in the product it is helping create.

That happened in practice. Multiple sessions confused their role, treating future runtime behavior as present execution context. The fix was not another paragraph saying “be careful.” The fix was to make actor identity structural.

## The original problem

The repository previously placed both development-time and runtime-only Pi resources under `.pi/`:

```text
.pi/
  agents/
    craft-builder.md
    craft-evaluator.md
    local-craft-builder.md
    local-craft-evaluator.md
  skills/
    craft/
    craft-pool/
```

Pi auto-discovers project resources under `.pi/`. A local session therefore saw two plausible identities:

- local CRAFTS agent helping implement the repository;
- pool CRAFTS agent executing a DAG node.

The product documentation made the ambiguity worse. It correctly described workers, node attempts, `craft-pool`, grading, and orchestration—but an LLM does not automatically distinguish between a document's **subject** and its own **actor**.

A spec saying “the worker must…” can be interpreted as either:

- “build software whose worker eventually does this”; or
- “you are the worker; do this now.”

Humans resolve that distinction from context almost invisibly. Agents need it represented explicitly.

## The key distinction

The solution names two actors and gives each one a separate discovery surface.

### Repository Builder

A Repository Builder is a local Pi session developing the product.

It:

- edits this repository;
- reads product specifications and ADRs;
- uses `/goal`, local `craft`, and `local-craft-*` agents;
- may implement approved product behavior;
- must not act as though the supervisor or pool already exists.

This is the default role.

### Pool Worker

A Pool Worker is a fresh Pi session launched by the completed supervisor to execute exactly one node attempt.

It:

- receives a bounded unit and original acceptance criteria;
- uses runtime `craft-pool` and `craft-*` phase agents;
- follows exact model and tool grants;
- emits validated artifacts;
- escalates decisions outside its assigned unit;
- may not redesign the system that launched it.

This role must be proven by launch context, not inferred from prose.

## The structural solution

### 1. Separate the files

Repository Builder resources remain auto-discoverable:

```text
.pi/
  agents/local-craft-*.md
  skills/craft/
  skills/goal/
  settings.json
```

Pool Worker resources moved into an explicit Pi package:

```text
packages/worker-harness/
  agents/craft-*.md
  skills/craft-pool/
  contracts/
  config/
  scripts/preflight.mjs
```

The worker package is deliberately not listed in local `.pi/settings.json`. A Repository Builder cannot casually select a runtime-only agent because Pi no longer discovers those agents locally.

The future supervisor or worker image must load the package explicitly.

### 2. Make runtime identity machine-readable

The trusted supervisor creates a per-attempt marker:

```json
{
  "schema_version": 1,
  "actor": "pool-worker",
  "node_id": "node-123",
  "attempt_id": "attempt-456",
  "issued_by": "agent-pool-supervisor",
  "issued_at": "2026-04-13T12:00:00Z",
  "target_repo": "owner/repository",
  "target_branch": "main"
}
```

It also sets:

```text
AGENT_POOL_ACTOR=pool-worker
AGENT_POOL_NODE_ID=node-123
AGENT_POOL_ATTEMPT_ID=attempt-456
AGENT_POOL_TARGET_REPO=owner/repository
AGENT_POOL_TARGET_BRANCH=main
```

The marker is ephemeral, ignored by Git, and supplied as launcher-owned state. Preflight binds its identity and repository/branch target to independent expected environment values and rejects markers older than five minutes. It is still not a security credential; it is an execution invariant that removes role ambiguity.

### 3. Fail closed before model work

`craft-pool` now requires the worker-harness preflight before reading the unit or launching a phase.

The preflight validates:

- actor environment and marker shape;
- declared supervisor issuer, freshness, and marker identity/target bound to launcher-supplied expectations;
- required runtime agents, skill, and schemas;
- exact model allowlist and live Pi registry availability;
- builder/evaluator diversity and capability ordering;
- phase write restrictions;
- pinned Graphify availability.

If anything is missing, the session stops before paid model work begins.

This changes the role boundary from a suggestion into an executable contract.

### 4. Separate audience from subject

Documentation can now distinguish who should act on it from what it describes:

```yaml
audience: repository-builder | pool-worker | both
subject: development-harness | product-runtime
```

This is the subtle but important idea: a document can describe the product runtime while being addressed to the Repository Builder implementing it.

Product documentation is not runtime identity.

## Why prompt-only separation was insufficient

A banner helps. Naming helps. But prompt-only rules compete with every other instruction in the model's context.

The repository contains detailed runtime specifications because builders need them. Removing those details would make implementation worse. Repeating “you are not a worker” throughout every document would add noise and still be non-deterministic.

Physical discovery boundaries and executable preflight checks are more reliable because they reduce the number of plausible actions available to the model:

- local sessions discover only local agents;
- runtime sessions receive only runtime assets;
- worker behavior requires evidence of a worker launch.

The model no longer has to infer which world it inhabits.

## General design lesson

Agents need identity and authority modeled like any other trust boundary.

When agents build systems that contain agents, separate:

- **who is acting**;
- **what system is being described**;
- **which capabilities are discoverable**;
- **what evidence authorizes a role transition**.

Names alone are not enough. Prompts alone are not enough. Directory structure alone is not enough. The strongest design combines all four:

1. canonical actor vocabulary;
2. physically separate harness packages;
3. machine-readable execution context;
4. fail-closed capability preflight.

## Current implementation state

Implemented:

- Repository Builder banner in root `AGENTS.md`;
- local `local-craft-*` discovery retained under `.pi/`;
- runtime `craft-*` and `craft-pool` moved to `packages/worker-harness/`;
- Pi package manifest for explicit runtime loading;
- worker-specific instructions and runtime configuration;
- execution-context JSON Schema;
- executable preflight with model, tool, schema, Graphify, and actor checks;
- automated tests proving local isolation and marker behavior;
- documentation actor/subject classification.

Still owned by the future supervisor implementation:

- generate and protect the marker per attempt;
- explicitly load the worker package and settings;
- invoke preflight before node execution;
- prevent target-repository code from overwriting trusted launch state;
- retain the marker as audit metadata without treating it as authentication.

## Suggested writing angle

The strongest framing is not “we improved some prompts.” It is:

> When agents build agents, role confusion becomes an architecture problem—not a prompting problem.

The practical story is concrete:

- two sessions confused future runtime instructions for present identity;
- the repository exposed both roles through one auto-discovery surface;
- the fix separated actors, packages, context markers, and authority;
- the resulting system asks models to infer less and validates more.

That principle transfers beyond agent pools. Any recursive agent system—agent builders, evaluators evaluating evaluators, deployment agents creating deployment agents—needs an explicit answer to: **Which layer am I in, and what proves it?**
