---
audience: repository-builder
subject: product-runtime
status: accepted-design-implementation-deferred
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-039-agent-assisted-probe-execution.md
---

# Agent-Assisted Probe Workflow

## Scope

A **probe** is a bounded agent-assisted experiment that resolves a material uncertainty before dependent work begins. Its purpose is to mock boundaries, discover unknowns, falsify assumptions, and give later CRAFTS sessions durable evidence that prevents drift and over-engineering.

A probe is not a DAG node type, CRAFTS phase, miniature feature build, grader, or controller diagnosis action. It is a normal ADR-018 node with a controller-owned `probe` execution profile in proposal/runtime metadata.

## Why probes do not run CRAFTS

Full CRAFTS adds planning, independent assessment, security review, repair, and documentation calls intended for production implementation. Even the R→S lite path assumes an implementation plus documentation outcome. A simple uncertainty-resolution node does not justify that cost and can become over-designed by the process intended to constrain it.

Per ADR-039, an agent-assisted probe runs one fresh Worker session and exactly one `probing` model call. Bootstrap routing is `zai/glm-5.3` primary and `moonshot/kimi-k3` fallback; Moonshot is never primary.

## Approved probe input

The Gate 1/direct-plan review records:

- uncertainty or falsifiable hypothesis;
- boundary to mock or behavior to observe;
- known assumptions;
- permitted files, tools, and write surfaces;
- required evidence and deterministic validation command;
- wall-time, token, tool, and cost limits;
- downstream decisions or node criteria the result informs; and
- explicit non-goals, including the feature work the probe may not implement.

Security-sensitive, production-routed, credential-bearing, or expanded work cannot use this profile. It is resliced or escalated to normal CRAFTS before mutation.

## Execution and durable output

The probe agent may produce a contract test, fixture, mock adapter, migration rehearsal, benchmark, evidence report, feature-flagged seam, or non-routable interface. Throwaway spike code may be deleted after evidence extraction; durable consumers receive only production-safe artifacts.

The schema-valid probe artifact records:

- status: `supported`, `disproved`, or `inconclusive`;
- bounded commands and observations;
- assumptions confirmed/rejected;
- discovered constraints, failure modes, and dead ends;
- durable artifact paths and SHA-256 hashes;
- model/tool/cost/repository/commit provenance; and
- bounded non-authoritative downstream or amendment implications.

A deterministic host-owned validator checks scope, paths, commands, artifact hashes, commit shape, credentials, isolation, and cleanup. The probe cannot grade itself, alter routing, dispatch work, amend topology, or broaden acceptance criteria.

## DAG behavior

A supported probe unlocks approved dependents only after its durable artifact is integrated and reverified under the accepted delivery model. A disproved probe preserves its evidence but blocks the planned dependents and recommends ADR-024 amendment. An inconclusive probe fails without authorizing speculative implementation.

Future Conceptualize calls receive the approved probe artifact through a bounded evidence reference or repository artifact. C must state which conclusions it adopted, which uncertainty it will not reopen, any contradictory new evidence, and how the plan avoids documented dead ends. Raw probe transcripts are never forwarded.

## Implementation status

Implementation is deferred until after the 17-node direct-task-first functional deployment. Required work is:

1. a dedicated probe Worker profile and probe agent;
2. the ADR-020 `probing` routing row;
3. strict probe input/output schemas;
4. deterministic evidence validation and persistence;
5. bounded projection into dependent C payloads; and
6. hostile tests proving probe output cannot become controller authority.

Focused autonomous failure diagnosis remains separately deferred. ADR-036 discovered-work records and human amendment remain the governing paths for scope/topology consequences.
