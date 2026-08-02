---
title: Orchestrator Decomposition Harness
type: output
tags: [repository-builder, orchestrator-harness, decomposition, security]
created: 2026-08-01
updated: 2026-08-01
sources:
  - docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md
  - docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md
  - docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md
  - packages/orchestrator-harness/
  - src/domains/work-intake/decomposition-harness.ts
---

# Orchestrator Decomposition Harness

Implemented and tightened the separate control-plane decomposition harness. Deterministic Work Intake validates and sanitizes jobs, consumes revision-bound breadth context, routes to Kimi K3 or the sole approved Sol fallback, invokes the exact selected model, and validates only ADR-018's five emitted node fields. Schema-invalid output receives at most one bounded repair; the model has no persistence, approval, Gate 1, queue, or dispatch authority.

Hardened launch boundaries include digest-before-execution Pi verification, immediate pre-spawn reverification, fixed trusted interpreter/PATH, private launcher-owned HOME/XDG/prompt roots, controlled subtree cleanup, test-only dependency injection, and immutable provenance for prompt, routing, tool, package, graph revision, and actual Pi identity. Final Tighten passed.

Verification:

- Orchestrator harness: 54 passing
- Work Intake: 64 passing
- Root: 232 passing
- Worker harness: 18 passing
- Typecheck: passed

Related: [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]].
