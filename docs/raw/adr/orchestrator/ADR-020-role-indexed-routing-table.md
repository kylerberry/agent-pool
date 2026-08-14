# ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role

**Status:** Accepted — amended 2026-08-13

## Context

The eval-backed routing table's premise is "task type → best perf/cost model." Early framing drifted into benchmarking models only for the builder/Assess role and defaulting every other model call to some unstated choice. That is the exact "model chosen by vibes" failure the whole build rejects — and it makes the eval feel bolted on, present to demonstrate the technique rather than to earn its place.

## Decision

The routing table is **role-indexed**: every CRAFTS phase that is a model call is its own routing decision, with its own eval task class and its own "best perf/cost model" derived from that class. A model strong at building may be mediocre at decomposition — different rows, different winners.

Rows (one per model-call role):
- **Decomposition** — spec → DAG. Graded against known-good decompositions (boundaries + edges).
- **Probing** — bounded uncertainty → durable hypothesis evidence. One agent-assisted call outside CRAFTS; graded by deterministic evidence and downstream usefulness fixtures (ADR-039).
- **Planning (C)** — criteria → test strategy + plan. Graded by reference/judge.
- **Building (R/F)** — plan → passing code. Graded by tier-1 pass rate + cost. Self-grading (tests are the oracle).
- **Assessing (A)** — diff → catches real defects. Graded against known-defect fixtures.
- **Tightening (T)** — security review. Graded against planted vulnerabilities.
- **Sharpening (S)** — docs. Lowest-stakes; likely no dedicated eval.

Bootstrap capability is represented as tiers that permit honest ties, not a forced total order or array position:

- lower: GPT-5.6 Luna;
- standard: GLM-5.2, GPT-5.6 Terra, Kimi K2.7 Code;
- high: GLM-5.3, GPT-5.6 Sol, Kimi K3.

These are provisional operator-approved equivalence classes, not eval-derived claims. Builder/evaluator selection remains atomic: models differ, evaluator is never lower tier, a higher qualified tier is preferred, and a tied different evaluator is permitted only when no higher qualified evaluator is available.

Moonshot models are fallback-only. No bootstrap or eval-derived policy may select Moonshot as a primary or normal candidate, regardless of measured score. Building bootstraps to `zai/glm-5.2` with `moonshot/kimi-k2.7-code` fallback. Probing bootstraps to `zai/glm-5.3` with `moonshot/kimi-k3` fallback. Every exact Z.ai model must pass real Pool Worker qualification before eligibility. Provider quota/subscription exhaustion is availability evidence, not an assumed administrative account cap.

## Consequences

This is the data-backed routing the design claims: per-role model selection, each backed by its own measured task class, not one benchmark generalized across all roles. Operator policy constrains the eligible primary set before empirical optimization; eval evidence cannot promote a fallback-only provider.

Cost: seven task classes, each needing its own dataset and grader, and only R/F self-grades. Addressed by phased build order (ADR-021) — not by narrowing the design. The routing table's honest scope is role-indexed; the build is incremental. Implementations that require every model rank to be unique must migrate to tie-capable tiers before the approved Z.ai policy can be represented truthfully.
