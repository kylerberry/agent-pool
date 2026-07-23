---
title: ADR-016: Fixed Escalation Resolution Actions
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-016-fixed-escalation-resolution-actions.md
---

# ADR-016: Fixed Escalation Resolution Actions

## Summary

This ADR records `ADR-016: Fixed Escalation Resolution Actions` for the supervisor orchestrator design.

## Key decisions / claims

Four fixed resolution actions: 1. **Retry** (with optional task/context edit) — retry count resets, node redispatches through the normal pipeline. 2. **Manual fix** — human supplies the change directly, node marked complete, dependents unfreeze. 3. **Cancel branch** — that node and its still-frozen dependents are cancelled; rest of the DAG continues (per ADR-011). Cancelling a root node is this same action at the top. 4. **Override / force-pass** — human marks the node passed despite failing tiered grading; requires a logged reason and is flagged distinctly in the audit trail as a machine-gate bypass. No default "restart whole DAG from scratch" option — too blunt; cancel-branch covers the case where that's warranted.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-016-fixed-escalation-resolution-actions.md`
