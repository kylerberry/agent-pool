# ADR-024: Amend-DAG — Fifth Escalation Resolution Action

**Status:** Accepted — amended 2026-07-27
**Amends:** ADR-016 (fixed escalation resolution actions), ADR-003 (DAG as gated checkpoint)
**Extended by:** ADR-036 (discovered work records and governed DAG amendment)

## Context

Adversarial review identified a rigidity trapdoor: if a human approves a flawed DAG at Gate 1 and implementation later reveals a planned node boundary is impossible (a seam that exists in the plan but not in the code), the four ADR-016 actions cannot express "the topology is wrong." The only outs were cancel-the-branch or manual-fix — exactly the rigidity the quarantine was never meant to impose. The code graph (ADR-022) reduces the *frequency* of bad boundaries (structural edges are visible at decomposition time), but cannot eliminate them: some boundary failures are semantic or behavioral and only discoverable at build time — the same firsthand-discovery logic that gives C ownership of complexity (ADR-018).

## Decision

Add a fifth, human-initiated resolution action: **amend-DAG** (partial re-decomposition). The controller may recommend this action after a versioned contention threshold is crossed—using repeated actual integration failures or sustained predicted-vs-actual touch misses from ADR-019/023—but it must never execute amendment automatically or from predicted overlap alone.

Mechanics:
1. Human cancels the affected subtree (existing cancel-branch semantics).
2. The decomposer re-runs against **only the unmet remainder** of the spec intent, receiving the original spec slice plus the set of already-`passed` nodes as context.
3. The amendment output passes the same mechanical validation (ids, cycles, referential integrity). The controller then derives predicted-touch metadata from the current versioned code-graph snapshot and freezes both with the renewed Gate 1 proposal.
4. The combined amendment proposal receives **Gate 1 human approval again**. Approved amendment nodes append to the existing DAG and dispatch resumes normally.

Passed work is never discarded. The ADR-003 quarantine principle is preserved, restated precisely: the rule was never "the DAG is immutable" — it is "**the DAG never changes silently**." Every topology change is decomposer-proposed, mechanically validated, human-approved, and audit-logged; re-runs resume from the amended approved DAG.

## Consequences

ADR-036 defines the bounded Worker discovery record and controller classification that can supply amendment evidence. This ADR remains the sole topology-change mechanism: discovery alone never changes a DAG.

The pipeline has a machine-assisted exit from a bad decomposition that doesn't force whole-DAG cancellation or unassisted manual surgery. Amendment approvals are heavier human reviews than the original Gate 1 (the human is also implicitly ruling on why the original boundary failed) — acceptable, since amendments should be rare when the graph-informed decomposer is doing its job; frequent amendments are themselves a signal the decomposer row needs eval attention (ADR-020).
