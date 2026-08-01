---
title: Model Routing Foundation
type: output
tags: [model-routing, security, routing]
created: 2026-08-01
updated: 2026-08-01
sources:
  - docs/raw/adr/orchestrator/ADR-007-provider-agnostic-model-interface.md
  - docs/raw/adr/orchestrator/ADR-009-empirical-routing-threshold.md
  - docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md
  - docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md
---

# Model Routing Foundation

Implemented strict five-model, role-indexed bootstrap routing with actor-separated worker and orchestrator policy ownership. Explicit unavailable models fail closed; builder/evaluator selection is atomic, distinct, and capability-safe. Provider adapters are injected and policy-free, while routing decisions and errors are immutable, allowlisted, and credential-free.

Bootstrap rankings remain provisional. A future validated eval-derived policy may replace them without expanding the approved model scope or crossing actor-role boundaries.

Related: [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]].
