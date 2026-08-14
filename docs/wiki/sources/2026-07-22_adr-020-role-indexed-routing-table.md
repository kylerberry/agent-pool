---
title: ADR-020: Role-Indexed Routing Table — One Routing Decision Per Model-Call Role
type: source
tags: [source, routing, models, probe]
created: 2026-07-22
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md
---

# ADR-020: Role-Indexed Routing Table

Every model-call role has its own routing decision and eventual eval task class: decomposition, probing, planning, building, assessing, tightening, and sharpening.

Bootstrap capability uses ties rather than a false total order:

- lower: Luna;
- standard: GLM-5.2, Terra, Kimi K2.7 Code;
- high: GLM-5.3, Sol, Kimi K3.

The evaluator differs from the builder and is never lower tier; prefer a higher qualified tier and permit a tied different model only when no higher qualified evaluator is available.

Moonshot is fallback-only and cannot become primary through bootstrap, availability, explicit selection, or eval publication. Building routes GLM-5.2→Kimi K2.7 Code. Post-launch probing routes GLM-5.3→Kimi K3. Exact Z.ai eligibility requires real Pool Worker qualification.

Bootstrap tiers remain provisional. Builder-first eval calibration follows direct-task-first deployment.

## Related

- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/sources/2026-08-13_adr-039-agent-assisted-probe-execution|ADR-039: Agent-Assisted Probe Execution]]
