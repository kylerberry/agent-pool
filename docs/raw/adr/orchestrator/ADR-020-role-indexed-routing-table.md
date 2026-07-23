# ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role

**Status:** Accepted

## Context

The eval-backed routing table's premise is "task type → best perf/cost model." Early framing drifted into benchmarking models only for the builder/Assess role and defaulting every other model call to some unstated choice. That is the exact "model chosen by vibes" failure the whole build rejects — and it makes the eval feel bolted on, present to demonstrate the technique rather than to earn its place.

## Decision

The routing table is **role-indexed**: every CRAFTS phase that is a model call is its own routing decision, with its own eval task class and its own "best perf/cost model" derived from that class. A model strong at building may be mediocre at decomposition — different rows, different winners.

Rows (one per model-call role):
- **Decomposition** — spec → DAG. Graded against known-good decompositions (boundaries + edges).
- **Planning (C)** — criteria → test strategy + plan. Graded by reference/judge.
- **Building (R/F)** — plan → passing code. Graded by tier-1 pass rate + cost. Self-grading (tests are the oracle).
- **Assessing (A)** — diff → catches real defects. Graded against known-defect fixtures.
- **Tightening (T)** — security review. Graded against planted vulnerabilities.
- **Sharpening (S)** — docs. Lowest-stakes; likely no dedicated eval.

## Consequences

This is the data-backed routing the design claims: per-role model selection, each backed by its own measured task class, not one benchmark generalized across all roles. Cost: six task classes, each needing its own dataset and grader, and only R/F self-grades. Addressed by phased build order (ADR-021) — not by narrowing the design. The routing table's honest scope is role-indexed; the build is incremental.
