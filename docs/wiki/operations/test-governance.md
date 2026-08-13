---
title: Test Governance
type: operation
tags: [testing, evidence, verification]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/context/test-governance.md
---

# Test Governance

[[raw/context/test-governance|Canonical test governance]] defines the repository’s test lanes and evidence rules.

## Run lanes

- `npm run test:root` — deterministic domain tests.
- `npm run test:orchestrator` — control-plane harness.
- `npm run test:worker` — Worker harness.
- `npm run test:pool-proof` — deterministic Pool Proof unit/evidence checks.
- `npm run test:all` — deterministic aggregate.
- `npm run test:docker` — required non-skipping Docker lifecycle evidence.
- `npm run proof:reports:verify` — read-only retained-report validation.
- `npm run proof:stage1` / `npm run proof:stage2` — explicit real-model acceptance evidence; not ordinary CI.

The single-worker fixture is intentionally red before a Worker changes it. It is a proof input, not a repository regression.

## Durable rules

- Tests own and promptly clean only the resources they create.
- Ordinary tests never overwrite retained proof artifacts.
- Retained reports are manifest-hashed, schema-validated, privacy-bounded, and read-only during normal verification.
- Use AST/module policy checks for static dependency rules; do not infer runtime behavior from source substrings.
- Do not claim concurrency from same-process synchronous `Promise.all` or timing sleeps.
- Fakes prove only their explicit simulation; real Docker/Worker assertions stay in the explicit evidence lane.

## Related

- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/sources/2026-08-05_pool-proof-specification|Pool Proof Specification]]
