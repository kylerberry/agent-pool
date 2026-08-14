---
title: ADR-038: Node-Level Mainline Integration
type: source
tags: [source, adr, dag, integration, github, gate-2]
created: 2026-08-13
updated: 2026-08-13
sources:
  - docs/raw/adr/orchestrator/ADR-038-node-level-mainline-integration.md
---

# ADR-038: Node-Level Mainline Integration

> ⚠️ Proposed and deferred. The functional deployment uses ADR-015 and records real delivery evidence before reassessment.

Each independently verifiable node uses a short-lived PR into `main`. It retains Gate 2 review, prefers merge queue where available, and unlocks dependents only after a trusted adapter verifies the exact merged commit and required checks.

Nodes must be production-safe in isolation. Agent Pool integrates code; deployment remains the target repository's CI/CD decision. Before adoption, reconcile the proposal's hard-coded `main` with accepted target-branch support.

## Related

- [[wiki/sources/2026-07-22_adr-015-pr-granularity-by-connected-component|ADR-015: PR Granularity by Connected Component]]
- [[wiki/sources/2026-07-22_adr-017-test-suite-storage-and-reverification|ADR-017: Test Suite Storage and Re-verification]]
- [[wiki/sources/2026-08-13_adr-035-minimal-coherent-dag-nodes|ADR-035: Minimal Coherent DAG Nodes]]
