---
title: Pool Worker Execution Context Schema
type: source
tags: [source, schema, worker]
created: 2026-04-13
updated: 2026-04-13
audience: both
subject: product-runtime
sources:
  - docs/raw/specs/schemas/pool-worker-execution-context.schema.json
---

# Pool Worker Execution Context Schema

## Summary

Defines the strict supervisor-issued marker that identifies a fresh Pi session as a Pool Worker for one node attempt. The marker is validated with `AGENT_POOL_ACTOR=pool-worker` by the worker-harness preflight.

## Related pages

- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]

## Raw source

- `docs/raw/specs/schemas/pool-worker-execution-context.schema.json`
