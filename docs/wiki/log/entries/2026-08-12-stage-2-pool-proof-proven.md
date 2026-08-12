# 2026-08-12 — Stage 2 Pool Proof proven

## Milestone

Stage 2 Pool Proof passed. Two persistent ready slots ran three real Moonshot fixture jobs. The Harness terminated one launched Worker through its launcher-owned fault seam; the other active job continued, the remaining queued job dispatched, and two successful jobs produced independently verified commits. SQLite lifecycle and result records were truthful, and attempt resources were cleaned up.

Retained evidence: `packages/pool-proof-harness/reports/stage-2-proof-report.json` (SHA-256 `ebf9840337149ee89b4cbee97fe9306dee9ed2f782ba145de957664fd057a401`).

## Durable verifier guidance

Isolation reports retain bounded unsalted commitments with separate attempt binding, not raw sensitive probe values. Verifiers source trust-boundary facts independently rather than comparing an observation with an expectation derived from the same mutable source. Privacy tests derive fixture-sensitive values and prove detection by contaminating serialized evidence one value at a time.

## Next prerequisite

Pool Proof remains fixture-only, not authorization for arbitrary repositories. A persistent per-attempt sandbox lifecycle remains the prerequisite for the separately reviewed `agent-pool` dogfood task.
