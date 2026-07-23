# ADR-002: Fuzzy-In / Structured-Out Spec Boundary

**Status:** Accepted

## Context

Incoming specs/ADRs are markdown, not consistently structured. A deterministic controller needs a fixed schema to operate on, which risks forcing a prescribed input format onto users.

## Decision

No prescribed input format. A model-driven decomposition step accepts free-form markdown and normalizes it into a validated DAG schema. The deterministic controller only ever consumes the normalized DAG — never the raw spec.

## Consequences

Preserves input flexibility without compromising downstream determinism; the model absorbs format variance, the schema absorbs it into structure.

Cost: the decomposition step itself is non-deterministic and not directly replayable — addressed in ADR-003.
