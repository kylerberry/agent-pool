# ADR-006: N=3 Reliability Reps Per Task

**Status:** Accepted

## Context

A single run (N=1) can't distinguish a reliably-good model from one that's flaky — green 70% of the time, garbage 30%.

## Decision

Each task × model runs 3 times at Phase 1. Raise to 5+ later only for task classes showing inconsistent results.

## Consequences

~3x cost over N=1, but flakiness becomes visible instead of hidden. Keeps Phase 1 spend bounded given the small model count.
