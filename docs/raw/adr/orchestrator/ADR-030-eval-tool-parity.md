# ADR-030: Eval Tool Parity — "Bare" Means No CRAFTS, Not No Tools

**Status:** Accepted
**Amends:** ADR-021 (eval scope, builder-first)

## Context

ADR-021 states the harness measures a model **bare** — no CRAFTS wrapping — so the eval benchmarks the model rather than the pipeline. ADR-029 gives production builders a tool surface (grep/LSP, `graphify`, repo wiki). Read together, an ambiguity emerges: if eval-run builders have no tools but production builders do, the routing table measures a capability the system never actually exercises. Tool-use reliability varies substantially between models, so a model that wins bare could lose with tools, and the routing decision would be derived from the wrong signal.

## Decision

**"Bare" means without CRAFTS phase structure, not without tools.** Eval runs give the model the same tool surface a production builder gets: grep/LSP, `graphify`, and the repo's wiki/skills, with the same phase-scoped grants (ADR-029). What the harness strips is the phase-gate wrapper — no C planning it, no A reviewing it, no F fixing it — so the measurement isolates the model's own ability to take a unit and produce passing code.

## Consequences

The routing table measures the capability actually deployed: model + tools, minus pipeline scaffolding. Tool-use reliability becomes part of what the builder row measures, which is correct — it's a real determinant of production performance and a named requirement in the target role. Cost: eval runs need the same container/tool provisioning as production workers, so the harness can't be a trivially isolated script; acceptable, since the alternative is a routing table derived from a configuration that never runs.
