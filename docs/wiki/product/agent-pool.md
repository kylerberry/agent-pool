---
title: Warm Agent Pool
type: product
tags: [agent-pool, github, execution]
created: 2026-07-22
updated: 2026-07-22
sources:
  - docs/raw/specs/agent-pool-spec.md
---

# Warm Agent Pool

The warm agent pool is the execution substrate: always-on coding agents accept webhook tasks, run autonomous coding or coding-adjacent work through Pi, and deliver GitHub artifacts such as PRs, issues, or comments.

## Key constraints

- Self-hosted low-cost infrastructure target.
- Manual webhook intake for v1.
- GitHub is the output surface.
- Agents can select/fail over between coding backends while preserving task progress.
- Follow-up PR review work should retain original session context.

## Relationship to orchestrator

The supervisor orchestrator builds on the pool by dispatching DAG nodes as ordinary atomic tasks. The pool remains intentionally simple: it executes one task at a time without needing global DAG state.

## Related

- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
- [[wiki/architecture/orchestrator-adr-map|Orchestrator ADR Map]]
