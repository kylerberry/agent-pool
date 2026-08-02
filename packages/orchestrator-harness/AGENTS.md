# Agent Pool Orchestrator Harness

## Current Actor

You are an **orchestrator-control-plane** Pi session only when the trusted
launch preflight validates `AGENT_POOL_ACTOR=orchestrator-control-plane`, a
verified canonical absolute Pi launcher, package-owned explicit settings, and
isolated configuration roots.

## Purpose

Control-plane Pi assets for the deterministic supervisor orchestrator. This
package is physically separate from the Pool Worker harness and never loads
its CRAFTS conductor skill. It owns the decomposition checkpoint: taking a validated job,
retrieving bounded codebase breadth context, invoking the spec-decomposer,
validating ADR-018 output, optionally performing one bounded schema-only repair,
and returning the candidate DAG plus sanitized provenance.

## Scope

- Decomposition role routing via `config/model-routing.bootstrap.json`.
- Deterministic limit and sanitization policies.
- Spec-decomposer agent and `decompose-spec` skill.
- Preflight and launch scripts for the control-plane actor.

## Non-Goals

- Do not implement controller, queue, persistence, Gate 1, or dispatch.
- Do not perform duplicate-ID, dependency-integrity, cycle, or semantic DAG
  validation; those remain downstream deterministic checks.
- Do not load Pool Worker assets or its CRAFTS conductor skill.
- Do not add models, aliases, or unapproved fallbacks.

## Trust Boundaries

- Jobs are untrusted until schema, size, revision binding, and sanitization pass.
- Breadth context is sanitized and capped before entering prompts.
- Model output cannot contribute provenance, approval, or control actions.
- Production rejects test/mock environment controls; tests inject fakes only through test-local ports or executables.
- HOME, XDG, and prompt artifacts live only beneath a fresh launcher-owned private runtime subtree; cleanup may remove only that recorded subtree.
- Pi bytes are digest-checked before execution and reverified immediately before every spawn through an absolute trusted interpreter and fixed non-caller PATH.
- The adapter executes the router-selected provider-qualified model exactly; it never aliases, selects, or falls back independently.

## Verification

- Run `npm test --prefix packages/orchestrator-harness`.
- Cover hostile environment/PATH input, digest-before-execution, Kimi K3/Sol argv binding, runtime/prompt containment, controlled cleanup, and worker-package separation.
