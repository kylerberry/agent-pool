# 2026-08-13 — Test governance cleanup

## Milestone

The repository test inventory was audited and reorganized into explicit deterministic, Docker-evidence, retained-report, and real-model-proof lanes. The root aggregate now includes root-domain, orchestrator-harness, Worker-harness, and Pool Proof unit suites; the intentionally red Worker fixture remains outside every green aggregate.

Retained reports are schema/hash/provenance/privacy verified read-only. Docker lifecycle evidence remains non-skipping but is no longer an ordinary unit-test prerequisite or an implicit report publisher.

## Durable guidance

Tests own cleanup immediately, never sweep shared temporary roots, and mutate copied package fixtures rather than tracked configuration. Static import policy uses AST analysis; runtime isolation, concurrency, persistence, and cleanup require executable evidence. Same-process synchronous `Promise.all` is not concurrency evidence.

## Result

The cleanup replaced false test claims, added hostile/red-state coverage for discovered runtime gaps, split monolithic suites by production seam, and recorded `docs/raw/context/test-governance.md` as the canonical rule set.
