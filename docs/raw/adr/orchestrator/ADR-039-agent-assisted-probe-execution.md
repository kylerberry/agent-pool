# ADR-039: Agent-Assisted Probe Execution Outside CRAFTS

**Status:** Accepted
**Amends:** ADR-020 (role-indexed routing)
**Relates to:** ADR-001 (deterministic controller), ADR-024 (amend-DAG), ADR-035 (minimal coherent nodes), ADR-036 (discovered work)

## Context

Some planned boundaries remain materially uncertain until an agent mocks an interface, exercises platform behavior, or builds a narrow spike. Running full CRAFTS for this work is expensive and misleading: a probe does not produce a finished feature, and multiple planning/review/documentation model calls can over-engineer the very uncertainty the probe should cheaply resolve. The existing R→S lite flow still assumes implementation plus documentation and does not define a hypothesis/evidence result.

A probe must nevertheless leave durable signal for later CRAFTS sessions. Throwaway prose or a successful command without provenance lets later planners reopen settled questions, repeat dead ends, and drift beyond the evidence.

## Decision

An approved DAG may assign a controller-owned **probe execution profile** to a normal ADR-018 node. Execution profile is proposal/runtime metadata keyed to the node ID; it does not add a sixth decomposer field, leak topology to the Worker, or create a CRAFTS phase.

An agent-assisted probe runs:

- one fresh isolated Pool Worker session;
- exactly one `probing` model call;
- bounded read/write tools, paths, wall time, tokens, and cost;
- no C, R, A, F, T, or S phase sequence; and
- one deterministic host-owned evidence validator.

Per ADR-020, `probing` is a distinct model-call role. Bootstrap routing is `zai/glm-5.3` primary and `moonshot/kimi-k3` fallback. Moonshot remains fallback-only. The probing row is calibrated separately if later eval evidence warrants it.

The approved probe input states the uncertainty/hypothesis, boundary to mock, known assumptions, permitted surfaces, required evidence, budget, dependent decisions, and explicit non-goals. The Worker may create durable fixtures, contract tests, mock adapters, migration rehearsals, benchmarks, evidence reports, feature-flagged seams, or non-routable interfaces. It may not silently implement the feature whose boundary it investigates.

The result is a schema-valid, bounded, credential-free probe artifact containing:

- `supported | disproved | inconclusive` hypothesis status;
- commands and bounded observations;
- assumptions confirmed/rejected;
- discovered constraints, failure modes, and dead ends;
- durable artifact paths and hashes;
- model, tool, cost, repository, and commit provenance; and
- non-authoritative downstream/DAG implications.

The deterministic controller validates and persists the artifact. Probe output cannot grade work, alter routing, dispatch nodes, mutate acceptance criteria or topology, authorize new scope, or mark itself integrated.

A supported probe unlocks approved dependents only after its durable artifact is integrated and reverified under the accepted delivery model. A disproved probe preserves its evidence but blocks the planned dependents and recommends human-governed ADR-024 amendment. An inconclusive probe fails without authorizing speculative work.

Every dependent CRAFTS Conceptualize call receives the approved probe evidence through a bounded controller-owned evidence reference or repository artifact. C must identify conclusions adopted, settled uncertainties it will not reopen, contradictory new evidence, and how its plan avoids documented dead ends. Raw probe transcripts are never forwarded.

Security-sensitive, production-routed, credential-bearing, or expanded probe work cannot use the probe profile; it is resliced or escalated to normal CRAFTS before mutation.

## Consequences

Probes become cheap one-call evidence producers instead of miniature feature builds. Their durable artifacts constrain later planning and reduce drift and speculative architecture. The controller remains deterministic and the model remains advisory.

This capability is post-launch work, outside the nine-node functional deployment critical path. Implementation requires a probe Worker profile/agent, probing routing row, strict input/output schemas, evidence persistence/projection, deterministic verification, downstream C consumption, and hostile tests proving the probe cannot become a hidden controller.
