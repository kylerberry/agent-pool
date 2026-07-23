---
title: Domain-Driven Documentation Convention
type: source
tags: [source, ddd, documentation]
created: 2026-04-13
updated: 2026-04-13
sources:
  - docs/raw/context/domain-driven-documentation-convention.md
---

# Domain-Driven Documentation Convention

## Summary

Defines the bounded-domain source layout, required local agent instructions, and the CRAFTS Sharpen responsibility for retaining durable domain knowledge.

## Key decisions / claims

- Code is organized under `src/domains/<domain>/`.
- Every domain has canonical `AGENTS.md` and a `CLAUDE.md` pointer.
- Cross-domain interaction uses explicit interfaces rather than internal coupling.
- S updates local instructions and wiki synthesis, while canonical requirements and decisions originate in `docs/raw/`.

## Related pages

- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]

## Raw source

- `docs/raw/context/domain-driven-documentation-convention.md`
