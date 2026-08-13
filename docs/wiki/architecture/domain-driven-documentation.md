---
title: Domain-Driven Documentation
type: architecture
tags: [ddd, domains, documentation, crafts]
created: 2026-04-13
updated: 2026-04-13
sources:
  - docs/raw/context/domain-driven-documentation-convention.md
---

# Domain-Driven Documentation

Application code is organized by bounded domain under `src/domains/`. Each domain owns its business rules and exposes narrow interfaces; cross-domain interactions use explicit services, events, or contracts.

## Local instructions

Every domain directory contains:

- `AGENTS.md` — canonical, actionable domain knowledge.
- `CLAUDE.md` — only `@AGENTS.md`.

Local instructions cover terminology, invariants, interfaces, trust boundaries, relevant sources, verification, and recurring footguns. They are read before editing the domain.

## CRAFTS maintenance rule

S — Sharpen captures durable learning after meaningful work. It updates the relevant domain instructions and wiki synthesis; canonical requirements and decisions belong in `docs/raw/` first. Transient implementation detail is intentionally excluded.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/overview|Project Overview]]
- [[wiki/operations/test-governance|Test Governance]]

## Raw source

- `docs/raw/context/domain-driven-documentation-convention.md`
