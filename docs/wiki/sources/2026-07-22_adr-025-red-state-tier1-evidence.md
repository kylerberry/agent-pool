---
title: ADR-025: Red-State Evidence — The Test Suite Must Prove It Can Fail
type: source
tags: [source, ingest]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/adr/orchestrator/ADR-025-red-state-tier1-evidence.md
---

# ADR-025: Red-State Evidence — The Test Suite Must Prove It Can Fail

## Summary

This ADR records `ADR-025: Red-State Evidence — The Test Suite Must Prove It Can Fail` for the supervisor orchestrator design.

## Key decisions / claims

**Red-state evidence is a tier-1 requirement.** The R phase's TDD loop is enforced, not advisory: before implementation, the suite (or each new test) must be executed against the pre-change tree and **demonstrated failing**, with the red-run output captured as part of the node's tier-1 evidence. The grading contract becomes: red on pre-change tree → green on post-change tree. A suite that cannot produce a red state is mechanically rejected at tier 1 — no model judgment involved. Recorded evidence per attempt: red-run output (pre-change), green-run output (post-change), both tied to the suite content hash (ADR-017) in the audit trail.

## Related pages

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-025-red-state-tier1-evidence.md`
