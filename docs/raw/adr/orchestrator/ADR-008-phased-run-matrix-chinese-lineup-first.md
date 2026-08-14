# ADR-008: Phased Run-Matrix Rollout, Chinese Lineup First

**Status:** Accepted — amended 2026-08-13

## Context

Full matrix is 18 models (3 tiers × 6 providers) — too large to debug the harness against on day one.

## Decision

- **Phase 1:** mid-tier only from Moonshot, Z.ai, Qwen (3 models) — chosen on cost and reasoning/coding benchmark strength, not as a placeholder. Exact model IDs are versioned run inputs rather than frozen historical examples.
- The direct-task-first deployment qualifies exact Z.ai models `zai/glm-5.2` and `zai/glm-5.3` before builder eval calibration. Moonshot remains measurable in eval but is fallback-only in production policy and cannot become primary.
- **Phase 2:** expand to full 3×3 Chinese-provider matrix.
- **Phase 3:** add Anthropic/OpenAI/Google.

## Consequences

Cheapest possible debug cycle for proving the harness end-to-end. Per ADR-007, expansion is pure config — no rework.
