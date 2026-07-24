# ADR-004: Tiered Grading, Not Tests-as-Sole-Grader

**Status:** Accepted

## Context

The agent pool's test suite arbitrates merge admissibility through optimistic concurrency and integration re-verification, but tests only catch regressions in covered behavior—not code quality or bugs outside test scope. Using tests as the sole success signal would let both the pipeline and the eval harness reward code that narrowly passes while being otherwise poor.

## Decision

Two-tier grading.

- **Tier 1 (deterministic, blocking):** tests, lint, typecheck, static/security analysis, coverage delta — binary pass/fail, necessary but not sufficient.
- **Tier 2 (model-judged):** a second model scores acceptance-criteria fit, code quality, regression risk outside coverage, and usability — a rubric score, not pass/fail.

Composite of both feeds the HITL gate and the eval harness's routing table.

## Consequences

Routing decisions and quality gates reflect actual output quality, not just green-test gaming. Also yields a self-generating metric — tier-2 catch rate per task class — indicating how far tests alone can be trusted for that class over time.

Cost: adds a second model call per unit; acceptable given it's the review checkpoint, not per-token generation.
