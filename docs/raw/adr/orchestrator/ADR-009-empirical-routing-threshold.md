# ADR-009: Empirical Routing Threshold, Not Hardcoded

**Status:** Accepted

## Context

The routing rule needs a composite-score cutoff to decide "cheap model qualifies" vs. "escalate to a pricier tier." An illustrative 80% figure had been used in earlier discussion but was never justified by data.

## Decision

No threshold is fixed in advance. Per-task-class thresholds are derived from the actual Phase 1 score distribution once real runs exist — picked at a natural separation point between tiers, not an arbitrary round number.

## Consequences

Routing rule is defensible with evidence rather than asserted. Cost: the routing table can't be fully specified until Phase 1 data exists — acceptable, since Phase 1's entire purpose is generating that data.
