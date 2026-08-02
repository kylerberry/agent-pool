---
title: Pool Worker Execution Context Schema
type: source
tags: [source, schema, worker]
created: 2026-04-13
updated: 2026-07-31
audience: both
subject: product-runtime
sources:
  - docs/raw/specs/schemas/pool-worker-execution-context.schema.json
---

# Pool Worker Execution Context Schema

## Summary

Defines the strict supervisor-issued marker that identifies a fresh Pi session as a Pool Worker for one node attempt. The marker is validated with `AGENT_POOL_ACTOR=pool-worker` by the worker-harness preflight.

## Version 2 (2026-07-31)

`schema_version` is now `2`. The marker additionally binds:

- `workspace_path` — the ephemeral per-attempt workspace this context authorises. Preflight compares it to the launcher workspace after `realpath` resolution on both sides.
- `expires_at` and `max_age_seconds` — the **launcher-owned** freshness expectation, replacing a window hardcoded in preflight. The five-minute ceiling from `orchestrator-spec.md` §2.1 still binds as a maximum: a launcher may be stricter, never laxer.
- `attempt_nonce` — a single-use launcher-generated value. Preflight validates its shape only; cross-launch replay detection is supervisor-owned state.

This is a breaking change for any launcher emitting a v1 marker.

## Related pages

- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]
- [[wiki/sources/2026-07-31_pool-worker-attempt-contract-schema|Pool Worker Attempt Contract Schema]]
- [[wiki/log/entries/2026-07-31-isolated-pool-worker-execution|Isolated Pool Worker Execution]]

## Raw source

- `docs/raw/specs/schemas/pool-worker-execution-context.schema.json`
