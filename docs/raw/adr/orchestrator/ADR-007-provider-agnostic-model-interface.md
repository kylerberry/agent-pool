# ADR-007: Provider-Agnostic Model Interface

**Status:** Accepted

## Context

Six candidate providers (Anthropic, OpenAI, Google, Moonshot, Z.ai, Qwen) were evaluated. Question raised: does provider choice affect the design?

## Decision

All model calls go through a thin per-provider adapter normalized to one input/output contract. Providers are interchangeable configuration, not architecture — the orchestrator and routing table have no provider-specific logic.

## Consequences

Any provider can be added, removed, or swapped without touching core orchestrator code. Directly enables ADR-008's phased rollout. Also becomes an interview point: the system was validated across six providers on two continents with zero core-code changes.
