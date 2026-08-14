---
title: Agent-Assisted Probe Workflow
type: source
tags: [source, accepted, dag, probe, evidence]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/plans/probe-node-workflow-proposal.md
  - docs/raw/adr/orchestrator/ADR-039-agent-assisted-probe-execution.md
---

# Agent-Assisted Probe Workflow

> Accepted design; implementation is deferred until after the direct-task-first deployment.

A probe uses one fresh Worker and one `probing` model call—not full CRAFTS or the R→S lite flow—to mock a boundary, discover unknowns, and preserve durable signal for later CRAFTS sessions.

Its strict artifact records supported/disproved/inconclusive status, bounded observations, confirmed/rejected assumptions, dead ends, durable fixtures/contracts/mocks, hashes, cost/model provenance, and non-authoritative implications. The deterministic controller validates it; the probe cannot grade, dispatch, route, amend, or broaden scope.

Supported probes may unlock approved dependents after integration. Disproved probes preserve evidence but block dependents and recommend amendment. Future C must consume the evidence and explain how it avoids settled dead ends.

Routing: GLM-5.3 primary, Kimi K3 fallback. Security-sensitive or production-routed work escalates to normal CRAFTS.

## Related

- [[wiki/sources/2026-08-13_adr-039-agent-assisted-probe-execution|ADR-039: Agent-Assisted Probe Execution]]
- [[wiki/sources/2026-08-13_adr-035-minimal-coherent-dag-nodes|ADR-035: Minimal Coherent DAG Nodes]]
- [[wiki/sources/2026-08-13_adr-036-discovered-work-and-dag-amendment|ADR-036: Discovered Work and DAG Amendment]]
