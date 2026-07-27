---
title: ADR-024: Amend-DAG — Fifth Escalation Resolution Action
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-024-amend-dag-resolution-action.md
---

# ADR-024: Amend-DAG — Fifth Escalation Resolution Action

## Summary

This ADR records `ADR-024: Amend-DAG — Fifth Escalation Resolution Action` for the supervisor orchestrator design.

## Key decisions / claims

Add a fifth, human-initiated resolution action: **amend-DAG** (partial re-decomposition). Mechanics: 1. Human cancels the affected subtree (existing cancel-branch semantics). 2. The decomposer re-runs against **only the unmet remainder** of the spec intent, receiving the original spec slice plus the set of already-`passed` nodes as context. 3. The amendment output passes the same mechanical validation (ids, cycles, referential integrity) and then **Gate 1 human approval again**. 4. Approved amendment nodes append to the existing DAG; dispatch resumes normally. Passed work is never discarded. The ADR-003 quarantine principle is preserved, restated precisely: the rule was never "the DAG is immutable" — it is "**the DAG never changes silently**." Every topology change is decomposer-proposed, mechanically validated, human-approved, and audit-logged; re-runs resume from the amended approved D

The 2026-07-27 amendment permits the controller to recommend amend-DAG after measured contention thresholds, while preserving mandatory human initiation, mechanical validation, and renewed Gate 1 approval. Predicted overlap alone can never trigger an amendment.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-024-amend-dag-resolution-action.md`
