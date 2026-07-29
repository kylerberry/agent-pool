---
title: ADR-029: Agent Tool Surface — Pull Not Push, Scoped Per Phase
type: source
tags: [source, orchestrator]
created: 2026-04-13
updated: 2026-07-27
sources:
  - docs/raw/adr/orchestrator/ADR-029-agent-tool-surface-and-phase-scoping.md
---

# ADR-029: Agent Tool Surface — Pull Not Push, Scoped Per Phase

## Summary

Phase knowledge is pulled from the target repository, not from Agent Pool product docs. C/R/F/A/T receive target-repository instructions, docs, direct lookup tools, graph access, and only controller-approved external providers. S may write only to an owner-approved target-repository knowledge sink; when none exists, it returns a structured proposal rather than creating one.

Target-repository MCP configuration is untrusted and cannot auto-launch a server. External providers are deferred until controller onboarding can enforce pinning, read-only allowlists, scoped secrets/egress, phase grants, and provenance.

## Related pages

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]

## Raw source

- `docs/raw/adr/orchestrator/ADR-029-agent-tool-surface-and-phase-scoping.md`
