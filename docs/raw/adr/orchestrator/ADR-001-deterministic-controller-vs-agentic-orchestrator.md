# ADR-001: Deterministic Controller vs. Agentic Orchestrator

**Status:** Accepted

## Context

The orchestrator supervises spec decomposition, dispatch to the agent pool, tiered grading, and escalation. It could be built as an autonomous agent reasoning end-to-end, or as deterministic code that calls models only at bounded checkpoints.

## Decision

Deterministic controller. Control flow — sequencing, retry ceilings, budget enforcement, escalation triggers, PR assembly — lives in code. Models are invoked only at named checkpoints (decomposition, review adjudication, failure diagnosis) and their output feeds back into the deterministic flow.

## Consequences

Gains replayability, auditability, and structural (not prompt-based) guardrails — retry limits and budget caps can't be reasoned around.

Cost: less adaptive to control-flow novelty than a free-roaming agent; new control paths require code changes, not prompt changes.

Accepted because the system's core value proposition is enterprise trust, and non-reproducible control flow is disqualifying for an audit-driven system.
