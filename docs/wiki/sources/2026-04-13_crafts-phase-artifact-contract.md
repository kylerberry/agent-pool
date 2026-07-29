---
title: CRAFTS Phase Artifact Contract
type: source
tags: [source, orchestrator]
created: 2026-04-13
updated: 2026-07-27
sources:
  - docs/raw/specs/crafts-phase-artifact-contract.md
---

# CRAFTS Phase Artifact Contract

## Summary

Canonical project decision or contract incorporated into the current supervisor-orchestrator design. Read the raw source for exact requirements and rationale.

## Elevated-risk security policy

Full-flow C emits a unique `security_triggers` subset from a closed vocabulary rather than a subjective risk score. Any trigger deterministically requires an independent `security-and-hardening` plan review after C and before R; an empty list keeps the normal flow. Existing trust-boundary and test-strategy fields carry the concrete plan, avoiding separate asset inventories or abuse-case documents. T still maps every declared trust boundary to evidence, a finding, or non-applicability. Reusable Tighten findings receive one Sharpen disposition: guidance update, owned follow-up, or documented non-generalizability.

## Related pages

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]

## Raw source

- `docs/raw/specs/crafts-phase-artifact-contract.md`
