---
title: Pool Worker Attempt Contract Schema
type: source
tags: [schema, agent-execution, worker-harness]
created: 2026-07-31
updated: 2026-07-31
sources:
  - docs/raw/specs/schemas/pool-worker-attempt-contract.schema.json
---

# Pool Worker Attempt Contract Schema

Canonical source: `docs/raw/specs/schemas/pool-worker-attempt-contract.schema.json`
(mirrored into `packages/worker-harness/contracts/`).

## Summary

Defines the single unit payload a DAG-unaware Pool Worker executes for one attempt
(ADR-010). One worker, one contract: the harness rejects zero or many rather than
selecting one.

## Key claims

- `additionalProperties: false` rejects DAG topology structurally; the harness
  additionally sweeps nested values for topology keys, so structure cannot ride inside
  an otherwise-permitted field.
- `acceptance_criteria` is immutable ground truth with at least one entry and unique
  ids. C never re-authors it.
- `criteria_origin` records provenance (`decomposition` or `direct-task`) plus a source
  id, satisfying the orchestrator specification's criteria-provenance binding.
- `prior_failure_context` carries ADR-026 failure artifacts from earlier attempts so a
  retry never starts blind. It holds artifacts, never transcripts.

## Open seam

The controller-side authoring of this payload belongs to the `work-contracts-direct-intake`
slice. Only the worker-side consumption boundary is defined here; the two must be
reconciled at integration.

## Related

- [[wiki/index|Wiki Index]]
- [[wiki/sources/2026-04-13_pool-worker-execution-context-schema|Pool Worker Execution Context Schema]]
- [[wiki/sources/2026-07-22_adr-010-dag-orchestration-node-level-dispatch|ADR-010: DAG-Level Orchestration, Node-Level Queue Dispatch]]
- [[wiki/log/entries/2026-07-31-isolated-pool-worker-execution|Isolated Pool Worker Execution]]
