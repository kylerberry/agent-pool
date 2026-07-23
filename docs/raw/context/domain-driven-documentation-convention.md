# Domain-Driven Documentation Convention

## Purpose

Application code is organized by bounded domain under `src/domains/`. Each domain owns its business rules, state transitions, public interfaces, tests, and actionable local knowledge.

## Domain Instruction Files

Every domain directory must contain:

- `AGENTS.md` — canonical domain-specific instructions.
- `CLAUDE.md` — exactly `@AGENTS.md`.

A domain `AGENTS.md` records only actionable, durable knowledge for work in that domain:

- purpose and canonical domain terms;
- owned entities, state transitions, and invariants;
- public interfaces and permitted cross-domain interactions;
- external dependencies and trust boundaries;
- relevant raw specs, ADRs, and wiki pages;
- test/verification guidance and common footguns.

Before editing a domain, agents read root `AGENTS.md`, `docs/AGENTS.md`, the wiki pages relevant to the task, and then that domain's `AGENTS.md`.

## Boundary Rules

Domains expose narrow interfaces. Cross-domain interactions occur through explicit services, events, or contracts; domains do not reach into another domain's internals.

## CRAFTS Sharpen Responsibility

The S — Sharpen phase keeps this knowledge current after meaningful work. It must determine whether the change established a domain invariant, interaction rule, test convention, operational gotcha, terminology change, or architecture decision worth retaining. When it did, S updates the relevant domain `AGENTS.md` and affected wiki pages; canonical requirements or decisions are recorded in `docs/raw/` first.

S does not record transient implementation noise.
