# ADR-012: Fixed Global Retry Ceiling, Per-Class Override Downward Only

**Status:** Accepted

## Context

ADR-004 and ADR-011 both reference a retry ceiling before escalation, but no concrete rule existed.

## Decision

A single global retry ceiling (e.g., 3) applies to every unit by default. Per-task-class overrides are permitted only to lower the ceiling, never raise it — a class can fail faster, never slower.

## Consequences

Yields an unconditional, easy-to-state trust guarantee: no unit retries more than the global max, regardless of configuration. Removes the failure mode of a misconfigured class looping indefinitely. Slight rigidity: a class that genuinely needs more attempts can't get them without raising the global ceiling itself.
