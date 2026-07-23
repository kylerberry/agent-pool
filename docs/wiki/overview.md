---
title: Project Overview
type: overview
tags: [overview]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/specs/orchestrator-spec.md
  - docs/raw/specs/agent-pool-spec.md
  - docs/raw/adr/orchestrator/
---

# Project Overview

This project defines a self-hosted agent execution system in two layers:

1. **Warm Agent Pool** — the task execution substrate for coding agents.
2. **Supervisor Orchestrator** — a deterministic controller that decomposes feature specs into approved DAGs, dispatches node-level work, grades outputs, enforces retry/cost ceilings, and produces auditable GitHub artifacts.

The initial design is pre-implementation and centered on trust, low-cost pragmatism, and empirical model routing. Implementation will use bounded domains under `src/domains/`, with local agent instructions maintained through CRAFTS Sharpen.

## Start here

- [[wiki/product/agent-pool|Warm Agent Pool]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
