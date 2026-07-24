# Initial Domain Map

**Status:** Proposed — requires human approval before feature implementation (ADR-034)

## Bounded domains

### Work Intake

Owns spec/direct-task submission, caller-scoped idempotency, decomposition requests, DAG schema validation, and Gate 1 approval/amendment. Exposes approved work definitions; does not dispatch nodes.

### Orchestration

Owns DAG/node lifecycle, ready-frontier calculation, attempts, retry/failure-class counters, budgets, escalation/resolution, leases, reconciliation, and orchestration audit state. Consumes approved work definitions and emits attempt requests.

### Agent Execution

Owns the warm worker pool, fresh Pi node sessions, CRAFTS phase sequencing, workspace lifecycle, phase capability grants, backend fallback, and validated phase artifacts. It is DAG-unaware and executes one attempt contract at a time.

### Verification

Owns tier-1 evidence, red/green attestations, suite path/hash history, tier-2 assessment contracts, composite verdicts, and integration re-verification. It does not mutate implementation code or orchestration state directly; it returns verdicts/evidence.

### Integration and Delivery

Owns branch integration, connected-component commit/PR assembly, GitHub delivery, Gate 2, review-comment mapping, and governed revision intake. Repository commands never hold delivery credentials.

### Model Routing and Evaluation

Owns provider-normalized model capabilities, approved model scope, role-indexed routing, eval datasets/runs, empirical thresholds, and routing-table publication. It provides a routing decision; it does not control DAG flow.

### Codebase Knowledge

Owns Graphify workspace indexes, graph refresh, wiki/index discovery, and retrieval contracts used by decomposition and phase agents. Grep/LSP remain direct tools; this domain owns provisioning and freshness, not agent reasoning.

## Platform adapters

SQLite repositories, BullMQ/Redis queues, GitHub clients, model-provider clients, container/sandbox runtime, filesystem workspaces, clocks, and telemetry are adapters behind domain interfaces. They contain no business policy.

## Dependency direction

```text
Work Intake -> Orchestration -> Agent Execution -> Verification
                         |                         |
                         +-------------------------+-> Integration and Delivery

Model Routing and Evaluation -> Agent Execution / Verification
Codebase Knowledge -> Work Intake / Agent Execution / Verification
```

Cross-domain communication uses explicit commands, results, and events carrying stable IDs. No domain reads another domain's persistence tables or internal modules.

## Approval questions

- Should audit-query behavior remain owned by Orchestration or become a separate Audit domain after implementation pressure appears?
- Should Codebase Knowledge remain a domain or be treated as a platform module until it gains independent lifecycle/policy?
