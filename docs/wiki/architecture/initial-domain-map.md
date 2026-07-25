---
title: Initial Domain Map
type: architecture
tags: [ddd, domains, approved]
created: 2026-04-13
updated: 2026-07-25
sources:
  - docs/raw/context/initial-domain-map.md
  - docs/raw/adr/orchestrator/ADR-034-domain-discovery-before-implementation.md
---

# Initial Domain Map

Approved by Kyler Berry on 2026-07-25. The bounded domains are:

- Work Intake
- Orchestration
- Agent Execution
- Verification
- Integration and Delivery
- Model Routing and Evaluation
- Codebase Knowledge

API endpoints and webhooks belong to the domain use cases they expose: Work Intake owns spec/task intake, Integration and Delivery owns GitHub webhook semantics and revision intake, and Orchestration owns status/escalation actions. HTTP routing, serialization, authentication middleware, and clients remain policy-free adapters. No separate API/Interface domain is needed for v1.

Infrastructure concerns—HTTP transport, SQLite, BullMQ/Redis, GitHub, model providers, sandboxing, workspaces, clocks, and telemetry—are adapters and contain no business policy.

See `docs/raw/context/initial-domain-map.md` for ownership, dependency direction, and approved resolutions.

## Related

- [[wiki/architecture/domain-driven-documentation|Domain-Driven Documentation]]
- [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]]
