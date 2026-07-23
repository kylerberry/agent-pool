# Docs Vault Librarian Rules

## Purpose

`docs/` is this codebase's Obsidian-style vault and durable project memory. It stores raw source artifacts, synthesized wiki pages, ADRs, PRDs, specs, issues, implementation notes, and operating knowledge for future agents and humans.

## Core Principle

Use **wiki-first, raw-when-needed** lookup.

- `docs/wiki/` is the navigable map and synthesis layer.
- `docs/raw/` is canonical source-of-truth input.
- Build agents should read relevant wiki pages first, then open raw sources only when they need exact wording, acceptance criteria, ADR rationale, or conflict resolution.

If wiki and raw source conflict, raw source wins. Flag contradiction and update wiki if asked or if safe.

## Directory Structure

```txt
docs/
├── AGENTS.md
├── raw/
│   ├── adr/
│   ├── context/
│   ├── specs/
│   ├── prds/
│   ├── issues/
│   ├── research/
│   ├── skills/
│   ├── plans/
│   └── assets/
├── wiki/
│   ├── index.md
│   ├── overview.md
│   ├── log.md
│   ├── log/entries/
│   ├── architecture/
│   ├── domains/
│   ├── features/
│   ├── integrations/
│   ├── operations/
│   ├── product/
│   ├── sources/
│   └── output/
└── .obsidian/
```

## Required Lookup Protocol For Build Agents

Before non-trivial code changes:

1. Read root `AGENTS.md`.
2. Read this file.
3. Read `docs/wiki/index.md`.
4. Read relevant wiki pages for the task.
5. Read linked raw artifacts only when exact source detail is needed.
6. Check ADRs before changing architecture, infra, persistence, auth, orchestration semantics, model routing, or integration boundaries.
7. If implementation reveals new durable knowledge, update or propose an update to the relevant raw artifact first, then update derived wiki pages.

New substantive documents go to `docs/raw/` first. Wiki pages summarize, connect, and index raw artifacts; they should not be the only source of a decision, spec, plan, map, or requirement.

## Raw Artifacts

Rules:
- Do not edit raw source during wiki synthesis unless the user explicitly asks to revise that artifact.
- Preserve ADR numbering.
- Store canonical specs in `docs/raw/specs/`.
- Store ADRs in `docs/raw/adr/`.
- Store domain/context source in `docs/raw/context/`.
- Store research and API artifacts in `docs/raw/research/`.
- Store implementation plans in `docs/raw/plans/` when durable.

## Domain-Driven Code Organization

Application code is organized under `src/domains/<domain>/`. Every domain owns a local `AGENTS.md` (with sibling `CLAUDE.md` containing only `@AGENTS.md`) that records its purpose, canonical terms, owned entities and invariants, public interfaces, dependencies, relevant sources, verification guidance, and footguns.

The CRAFTS S — Sharpen phase updates domain instructions and affected wiki pages when implementation establishes durable knowledge. Add canonical requirements or decisions under `docs/raw/` first; do not preserve transient implementation detail.

## Wiki Pages

Wiki pages are synthesized, linked, and optimized for retrieval.

### Activity Log Entries

Do not append new feature/change entries directly to `docs/wiki/log.md` from feature branches. For each meaningful change, add one fragment file under:

```txt
docs/wiki/log/entries/YYYY-MM-DD-short-slug.md
```

### Frontmatter

```yaml
---
title: Page Title
type: index | overview | source | domain | architecture | integration | operation | product | output
tags: [tag]
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - docs/raw/path.md
---
```

### Link Format

Use Obsidian links:

```md
[[wiki/path/to-page|Display Name]]
```

Every new page must be linked from at least one existing page. Orphan pages are bugs.

### Source Pages

Create `docs/wiki/sources/YYYY-MM-DD_slug.md` for important raw artifacts. Include summary, key decisions/claims, related pages, and raw source link.

## Ingest Workflow

When adding raw docs:

1. Read source file.
2. Create/update source page in `docs/wiki/sources/`.
3. Update affected product/architecture/integration/operation pages.
4. Update `docs/wiki/index.md`.
5. Update `docs/wiki/overview.md` if project understanding changed.
6. Add one activity-log fragment under `docs/wiki/log/entries/`.
7. Report files created/updated and notable connections.

Ask questions only when ambiguity blocks correct synthesis.

## Query Workflow

When user asks about project knowledge:

1. Read `docs/wiki/index.md`.
2. Read relevant wiki pages.
3. Open raw artifacts only for exact details or disputed claims.
4. Answer with concise citations to wiki/raw paths.
5. If answer is durable, ask whether to file it in `docs/wiki/output/`.

## Documentation Hygiene

- Keep pages focused; split pages over ~500 lines.
- Flag uncertainty with `> ⚠️ Unverified:`.
- Flag contradictions with `> ⚡ Contradiction:`.
- Prefer exact names from specs and ADRs.
- Use stable file names with lowercase kebab-case.
- Update index whenever adding/moving pages.
- Append meaningful changes to log fragments.
