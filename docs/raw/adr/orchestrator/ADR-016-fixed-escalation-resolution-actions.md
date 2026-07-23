# ADR-016: Fixed Escalation Resolution Actions

**Status:** Accepted

## Context

Escalated items surface via audit-trail query (no push-notification system, per the solo dual-use build decision), but no defined action set existed for what a human can actually do with one.

## Decision

Four fixed resolution actions:

1. **Retry** (with optional task/context edit) — retry count resets, node redispatches through the normal pipeline.
2. **Manual fix** — human supplies the change directly, node marked complete, dependents unfreeze.
3. **Cancel branch** — that node and its still-frozen dependents are cancelled; rest of the DAG continues (per ADR-011). Cancelling a root node is this same action at the top.
4. **Override / force-pass** — human marks the node passed despite failing tiered grading; requires a logged reason and is flagged distinctly in the audit trail as a machine-gate bypass.

No default "restart whole DAG from scratch" option — too blunt; cancel-branch covers the case where that's warranted.

## Consequences

Resolution stays auditable and bounded rather than ad hoc. Override's mandatory logging preserves the tiered-grading trust story (ADR-004) even when a human legitimately needs to bypass it — the bypass itself becomes visible, not silent.
