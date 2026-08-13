---
title: Test Governance
type: source
tags: [testing, verification, evidence]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/context/test-governance.md
---

# Test Governance

`docs/raw/context/test-governance.md` is the canonical test-lane and evidence policy.

## Key decisions

- Separate deterministic tests, Docker-backed acceptance evidence, retained-report verification, and real-model proof commands.
- Keep the single-worker fixture intentionally red before a Worker changes it; it is excluded from every green aggregate.
- Verify retained reports read-only by schema, manifest hash, provenance, and privacy; explicit publication is the only writer.
- Treat test-created paths, sockets, processes, containers, copied package fixtures, and candidate reports as owned resources with immediate scoped cleanup.
- Use AST/module analysis for static import policy. Do not claim runtime behavior from source text, timing sleeps, or same-process synchronous `Promise.all`.
- Split tests by production seam and keep fake-driver claims limited to their explicit simulation.

## Related

- [[wiki/operations/test-governance|Test Governance]]
- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/sources/2026-08-05_pool-proof-specification|Pool Proof Specification]]
