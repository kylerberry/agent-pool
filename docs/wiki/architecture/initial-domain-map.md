---
title: Initial Domain Map
type: architecture
tags: [ddd, domains, proposed]
created: 2026-04-13
updated: 2026-04-13
sources:
  - docs/raw/context/initial-domain-map.md
  - docs/raw/adr/orchestrator/ADR-034-domain-discovery-before-implementation.md
---

# Initial Domain Map

> ⚠️ Proposed: human approval is required before feature implementation.

The proposed bounded domains are:

- Work Intake
- Orchestration
- Agent Execution
- Verification
- Integration and Delivery
- Model Routing and Evaluation
- Codebase Knowledge

Infrastructure concerns—SQLite, BullMQ/Redis, GitHub, model providers, sandboxing, workspaces, clocks, and telemetry—are adapters and contain no business policy.

See `docs/raw/context/initial-domain-map.md` for ownership, dependency direction, and approval questions.

## Related

- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
