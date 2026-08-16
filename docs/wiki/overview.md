---
title: Project Overview
type: overview
tags: [overview]
created: 2026-07-22
updated: 2026-08-13
sources:
  - docs/raw/specs/orchestrator-spec.md
  - docs/raw/adr/orchestrator/
---

# Project Overview

This project defines a self-hosted agent execution system in two layers:

1. **Warm Agent Pool** — the task execution substrate for coding agents.
2. **Supervisor Orchestrator** — a deterministic controller that decomposes feature specs into approved DAGs, dispatches node-level work, grades outputs, enforces retry/cost ceilings, and produces auditable GitHub artifacts.

The design is centered on trust, low-cost pragmatism, and empirical model routing. The approved two-node Pool Proof is complete. The active 17-node plan is the shortest trustworthy direct-task-first deployment: qualify the bootstrap policy and GLM-5.2, qualify GLM-5.3 in parallel, dogfood the real runner, then activate the direct-task service, CRAFTS ledger/conductor, Tier-1/Tier-2 grading, the governed failure lifecycle with budget/discovery/recovery branches, accepted ADR-015 PR assembly behind GitHub Gate 2, the single-host operations baseline, and one release-convergence proof. Its sole ready root is unreserved; free-form intake, Graphify scheduling, probing implementation, and eval calibration remain post-launch. Local dispatch is governed by the approved plan's human approval plus the frozen plan SHA ([[wiki/sources/2026-08-16_local-repository-builder-workflow|local workflow authority]]); the exact-hash activation artifacts are historical evidence. An unapproved four-node replacement milestone candidate exists alongside it.

Pi sessions have explicit actors: Repository Builders develop the product through `.pi/`; deterministic product-runtime code launches fresh Pool Workers through an explicitly selected `packages/worker-harness/` profile. Launcher-verified context, private resources, sandboxed capabilities, and runner-owned result identity—not repository subject matter or prompt text—establish the Pool Worker boundary.

## Start here

- [[wiki/product/agent-pool|Warm Agent Pool]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/architecture/initial-domain-map|Initial Domain Map (approved)]]
- [[wiki/sources/2026-08-05_pool-proof-specification|Pool Proof Specification (completed build phase)]]
- [[wiki/sources/2026-08-13_functional-pool-deployment|Functional Pool Deployment (active)]]
- [[wiki/sources/2026-08-16_local-repository-builder-workflow|Local Repository Builder /goal Workflow (canonical authority)]]
- [[wiki/sources/2026-07-25_approved-v1-build-dag|Superseded v1 Build DAG history]]
- [[wiki/architecture/repository-builder-vs-pool-worker|Repository Builder vs Pool Worker]]
- [[wiki/sources/2026-08-13_adr-035-minimal-coherent-dag-nodes|Minimal Coherent DAG Nodes]]
- [[wiki/sources/2026-08-13_adr-036-discovered-work-and-dag-amendment|Discovered Work and DAG Amendment]]
- [[wiki/sources/2026-08-13_adr-037-github-planning-pr-gate1|ADR-037: GitHub Planning PRs as Gate 1 (Proposed/Deferred)]]
- [[wiki/sources/2026-08-13_adr-038-node-level-mainline-integration|ADR-038: Node-Level Mainline Integration (Proposed/Deferred)]]
- [[wiki/sources/2026-08-13_adr-039-agent-assisted-probe-execution|ADR-039: Agent-Assisted Probe Execution]]
