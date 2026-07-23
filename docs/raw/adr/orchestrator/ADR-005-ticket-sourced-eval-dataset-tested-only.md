# ADR-005: Ticket-Sourced Eval Dataset, Tested-Only

**Status:** Accepted

## Context

Two source codebases available — kkchat (complete) and subba (in-progress). kkchat's test coverage was inconsistent historically. subba's history is mostly structural/scaffolding work that doesn't decompose into small tested units; retrofitting tests onto it would grade memory, not an independent answer key.

## Decision

Seed set = any ticket from either codebase that already has a test. No retrofitting untested history. Dataset grows forward as new subba tickets are written with acceptance tests as standard practice.

## Consequences

Seed set starts smaller than the original 15–20 target, but every example has an honest, pre-existing answer key. Dataset quality improves over time as a byproduct of normal work rather than a one-time labor spike.
