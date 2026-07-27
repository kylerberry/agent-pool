# Work Intake — Domain Instructions

## Terms

- **Spec**: A structured work definition submitted by a caller, including intent, acceptance criteria, and optional constraints.
- **Direct task**: A spec that bypasses decomposition and maps to a single node.
- **Caller-scoped idempotency**: A guarantee that retrying the same submission with the same caller key returns the same spec identity without side effects.
- **Decomposition request**: A request to break a spec into a DAG of nodes with validated dependencies.
- **Gate 1**: The human approval or amendment checkpoint before a spec becomes an orchestrated run.

## Owned state

- Specs and their lifecycle status (draft, pending approval, approved, amended, rejected).
- Caller-scoped idempotency keys and resolved spec identities.
- Decomposition requests and resulting DAG schemas pending Gate 1.
- Gate 1 approval/amendment records and audit timestamps.

## Invariants

- A spec identity is stable for a given caller idempotency key.
- No spec proceeds to Orchestration without passing Gate 1.
- DAG schemas accepted from decomposition requests are validated for acyclicity and node-contract completeness before Gate 1.
- Amendment preserves the original spec lineage and re-requires Gate 1.

## Public interfaces

- `POST /specs` — submit a new spec or idempotent retry.
- `GET /specs/{id}` — retrieve a spec and its current status.
- Approval/amendment routes — Gate 1 actions producing an approved work definition.
- `POST /tasks` — submit a direct task that becomes a single-node spec.
- Emits **approved work definition** events to Orchestration.

## Dependencies

- Depends on Codebase Knowledge for decomposition context and approved documentation sources.
- Does not dispatch nodes; dispatch is Orchestration's responsibility.
- Uses policy-free HTTP adapters for inbound routes.

## Trust boundaries

- Caller inputs are untrusted: specs must be schema-validated and sanitized before persistence.
- Idempotency keys are caller-scoped but never exposed to other callers.
- Gate 1 approvals are authoritative human decisions and must be recorded immutably.
- This domain never holds orchestration, agent-execution, or delivery credentials.

## Verification guidance

- Validate spec schema, idempotency resolution, and Gate 1 state transitions with unit tests.
- Verify DAG schema validation rejects cycles and incomplete node contracts.
- Confirm approved work definitions are emitted with stable IDs and lineage.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/raw/specs/orchestrator-spec.md`

## Footguns

- Reusing idempotency keys across callers collapses ownership boundaries.
- Allowing Gate 1 amendment to skip re-validation can introduce cyclic or incomplete DAGs.
- Exposing internal spec IDs before approval leaks draft work.
