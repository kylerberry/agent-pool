# Agent Pool Orchestrator Harness

Control-plane Pi assets for the deterministic supervisor orchestrator.

This package is physically separate from `packages/worker-harness` and never
loads `craft-pool`. It owns the decomposition checkpoint: validated job intake,
bounded codebase breadth retrieval, deterministic model routing, ADR-018 schema
enforcement, optional one-repair retry, and immutable invocation provenance.

## Contents

- `agents/spec-decomposer.md` — read-only decomposition agent.
- `skills/decompose-spec/SKILL.md` — decomposition skill.
- `contracts/` — job and emission JSON schemas.
- `config/` — routing, limits, sanitization, settings, and runtime versions.
- `scripts/` — preflight and launch wrappers.
- `test/` — preflight and security tests.

## Verification

```bash
npm test --prefix packages/orchestrator-harness
```
