---
title: Project Overview
type: overview
tags: [overview]
created: 2026-07-22
updated: 2026-08-05
sources:
  - docs/raw/specs/orchestrator-spec.md
  - docs/raw/adr/orchestrator/
---

# Project Overview

This project defines a self-hosted agent execution system in two layers:

1. **Warm Agent Pool** — the task execution substrate for coding agents.
2. **Supervisor Orchestrator** — a deterministic controller that decomposes feature specs into approved DAGs, dispatches node-level work, grades outputs, enforces retry/cost ceilings, and produces auditable GitHub artifacts.

The design is centered on trust, low-cost pragmatism, and empirical model routing. After completing reusable foundations under the original full-v1 sequence, Kyler approved a two-node Pool Proof rescope on 2026-08-05. The current build phase first proves one real headless Worker against a controlled fixture, then proves two ready slots and failure isolation. The superseded governance-heavy DAG remains historical evidence; deferred v1 requirements remain authoritative but are not Pool Proof prerequisites.

Pi sessions have explicit actors: Repository Builders develop the product through `.pi/`; deterministic product-runtime code launches fresh Pool Workers through an explicitly selected `packages/worker-harness/` profile. Launcher-verified context, private resources, sandboxed capabilities, and runner-owned result identity—not repository subject matter or prompt text—establish the Pool Worker boundary.

## Start here

- [[wiki/product/agent-pool|Warm Agent Pool]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/architecture/initial-domain-map|Initial Domain Map (approved)]]
- [[wiki/sources/2026-08-05_pool-proof-specification|Pool Proof Specification (approved build phase)]]
- [[wiki/sources/2026-07-25_approved-v1-build-dag|Superseded v1 Build DAG history]]
- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]
