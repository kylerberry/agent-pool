# 2026-07-25 — Scaffold approved bounded domains

## Change

Added the seven ADR-034 approved bounded domains under `src/domains/<domain>/`:

- `work-intake`
- `orchestration`
- `agent-execution`
- `verification`
- `integration-and-delivery`
- `model-routing-and-evaluation`
- `codebase-knowledge`

Each domain directory contains:

- `AGENTS.md` — actionable domain instructions covering terms, owned state, invariants, public interfaces, dependencies, trust boundaries, verification guidance, relevant sources, and footguns.
- `CLAUDE.md` — pointer-only file containing exactly `@AGENTS.md`.

Added a structural test suite at `.pi/scripts/domain-scaffolding.test.mjs` that validates directory existence, pointer-only CLAUDE.md files, and required AGENTS.md categories.

## Evidence

- RED: `node --test .pi/scripts/domain-scaffolding.test.mjs` failed with 21 failures against base commit `62f815d867fec76e7ef2067f6cb8e3b0d3cec21b`.
- GREEN: Same suite passed with 21 passes after scaffolding.
- Validator: `node .pi/scripts/validate-goal-plan.mjs` passed with `map_sha256=fb20cbaadf9d6e1972fd42ad536d430f5d6f9fc40c18413f71c7dd78b1f9d775`.

## Scope preserved

- The approved domain map, approval record, and DAG were not modified.
- No runtime code, persistence, adapters, or APIs were implemented.
- No new API/Interface or infrastructure domain was created.
