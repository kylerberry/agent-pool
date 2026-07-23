# ADR-015: PR Granularity by DAG Connected Component, With Intent

**Status:** Accepted

## Context

Initial framing (one PR per whole DAG) risked producing unreviewable giant diffs — review effectiveness is known to degrade sharply past a few hundred lines, undermining the tiered-grading trust story it was meant to support.

## Decision

PR granularity follows the DAG's independent connected components — genuinely unrelated subtrees ship as separate PRs; a single dependency chain stays one PR by necessity but is structured as one commit per node, each carrying its own tier-1/tier-2 scorecard, cost, and model rationale. Every PR includes the originating spec/ticket intent alongside the mechanical diff, not just the changes themselves.

## Consequences

Review size scales with actual coupling, not spec size — independent work never forces an artificially large diff. Coupled work stays mergeable as one unit while still being reviewable incrementally. Intent inclusion means a human isn't reverse-engineering "why" from code and per-node scores alone.
