# ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First

**Status:** Accepted

## Context

Full matrix is 18 models (3 tiers × 6 providers) — too large to debug the harness against on day one.

## Decision

- **Phase 1:** mid-tier only from Moonshot, Z.ai, Qwen (3 models) — chosen on cost and reasoning/coding benchmark strength (e.g. GLM-4.7 at 73.8% SWE-bench Verified, $0.60/$2.20), not as a placeholder.
- **Phase 2:** expand to full 3×3 Chinese-provider matrix.
- **Phase 3:** add Anthropic/OpenAI/Google.

## Consequences

Cheapest possible debug cycle for proving the harness end-to-end. Per ADR-007, expansion is pure config — no rework.
