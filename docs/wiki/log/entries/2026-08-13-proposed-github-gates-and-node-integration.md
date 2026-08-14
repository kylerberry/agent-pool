---
title: Proposed GitHub-backed DAG gate and node-level integration
type: operation
tags: [orchestrator, dag, github, gate-1, gate-2, proposed]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-037-github-planning-pr-gate1.md
  - docs/raw/adr/orchestrator/ADR-038-node-level-mainline-integration.md
  - docs/raw/plans/probe-node-workflow-proposal.md
---

# Proposed GitHub-backed DAG gate and node-level integration

Recorded two proposed ADRs. ADR-037 moves editable Gate 1 DAG collaboration to a merged, deterministically validated GitHub planning PR. ADR-038 replaces connected-component delivery with reviewed node PRs integrated to `main`; only verified merges unlock dependents. A separate proposal defines probe nodes as ordinary merge-safe CRAFTS work and defers focused diagnosis.

No schemas, controller behavior, GitHub integration, queue contracts, CRAFTS skills, or tests changed.

- [[wiki/sources/2026-08-13_adr-037-github-planning-pr-gate1|ADR-037]]
- [[wiki/sources/2026-08-13_adr-038-node-level-mainline-integration|ADR-038]]
- [[wiki/sources/2026-08-13_probe-node-workflow-proposal|Probe Node Workflow Proposal]]
