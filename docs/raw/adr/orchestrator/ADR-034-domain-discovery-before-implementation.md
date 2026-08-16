# ADR-034: Domain Discovery Is the First Implementation Gate

**Status:** Accepted
**Relates to:** repository domain-driven documentation convention

## Context

The repository requires bounded domains and progressively disclosed local instructions, but no implementation exists from which domains can be inferred. Letting autonomous builders invent domains opportunistically would create unstable seams and inconsistent ownership.

## Decision

Before feature implementation, the autonomous build performs a domain-discovery slice:

1. derive candidate bounded domains from the canonical specification and ADRs;
2. define each domain's purpose, owned state, invariants, public interfaces, events/contracts, trust boundaries, and dependencies;
3. produce a dependency map and identify shared infrastructure adapters;
4. obtain human approval for the initial domain map;
5. create `src/domains/<domain>/AGENTS.md` and pointer-only `CLAUDE.md` files before code enters that domain.

Subsequent domain changes follow normal ADR/spec and S-phase documentation rules. Infrastructure libraries may live outside a domain only when they contain no business policy and expose explicit adapters to domains.

## Consequences

The autonomous build starts with explicit ownership and stable vocabulary rather than file-first architecture. The initial map may evolve, but changes are deliberate and documented rather than incidental.

## Amendment (2026-08-16): conditional map governance

The initial domain-discovery gate is unchanged, but re-approving the domain map for every feature plan is not required. Local Repository Builder plans carry a plan-level boolean `domain_boundaries_changed`; only a plan declaring `true` must present the approved domain-map record with a matching map SHA-256 before dispatch. Absence of the signal (legacy plans) and `false` mean no boundary change and perform no map reads; non-boolean values fail closed. The signal is a human-approved semantic declaration. See `docs/raw/context/local-repository-builder-workflow.md`.
