---
title: Project Overview
type: overview
tags: [overview]
created: 2026-07-22
updated: 2026-07-25
sources:
  - docs/raw/specs/orchestrator-spec.md
  - docs/raw/adr/orchestrator/
---

# Project Overview

This project defines a self-hosted agent execution system in two layers:

1. **Warm Agent Pool** — the task execution substrate for coding agents.
2. **Supervisor Orchestrator** — a deterministic controller that decomposes feature specs into approved DAGs, dispatches node-level work, grades outputs, enforces retry/cost ceilings, and produces auditable GitHub artifacts.

The initial design is pre-implementation and centered on trust, low-cost pragmatism, and empirical model routing. Kyler approved the seven-domain map and the 16-node Repository Builder DAG on 2026-07-25. Implementation begins with domain instruction scaffolding under `src/domains/`, with local guidance maintained through CRAFTS Sharpen.

Pi sessions have explicit actors: Repository Builders develop the product through `.pi/`; orchestrator-side model checkpoints such as decomposition use a separate control-plane harness; Pool Workers execute runtime nodes through the explicitly loaded `packages/worker-harness/`. A supervisor-issued marker and fail-closed preflight—not repository subject matter—establish Pool Worker identity.

## Start here

- [[wiki/product/agent-pool|Warm Agent Pool]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/architecture/initial-domain-map|Initial Domain Map (approved)]]
- [[wiki/sources/2026-07-25_approved-v1-build-dag|Approved v1 Build DAG]]
- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]
