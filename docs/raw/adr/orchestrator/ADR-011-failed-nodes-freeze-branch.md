# ADR-011: Failed Nodes Freeze Their Branch, Not the DAG

**Status:** Accepted

## Context

A DAG node can fail tiered grading and exhaust its retries. Its dependents, and the rest of the DAG, need defined behavior.

## Decision

A failed node never enters completed state, so its dependents simply never become ready — they freeze, not cancel. The failed node escalates to a human per the retry-ceiling envelope. Unrelated branches keep executing in parallel, unaffected. Frozen dependents resume once a human resolves the failed node (fix, override, or cancel that branch).

## Consequences

No wasted work on unrelated branches; failure blast radius is limited to the dependent subtree. Rejected auto-cancel-whole-DAG as too blunt — it would discard completed, unrelated work on a single failure. Requires the orchestrator to expose branch state (frozen/blocked) distinctly from in-progress, so a human reviewing the PR queue can tell "waiting on a decision" from "still running."
