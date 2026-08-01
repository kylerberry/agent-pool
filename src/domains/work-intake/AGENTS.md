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

- `POST /specs` — submit a new spec or idempotent retry. *(not yet implemented)*
- `GET /specs/{id}` — retrieve a spec and its current status. *(not yet implemented)*
- Approval/amendment routes — Gate 1 actions producing an approved work definition. *(not yet implemented)*
- `POST /tasks` — submit one direct unit or a hand-authored flat DAG. **Implemented**; exported from `index.ts` as `acceptDirectTasks` (domain boundary) and `handleDirectTaskRequest` (policy-free HTTP adapter).
- Emits **approved work definition** events to Orchestration. *(not yet implemented)*

### Direct-task path (implemented)

`acceptDirectTasks` is **synchronous by signature**. That is load-bearing, not stylistic: a synchronous function cannot await a model call, so "no decomposition occurs on this path" is enforced by the type rather than by convention. Do not make it `async`.

`gate2_required` is the literal type `true` and `gate1_required` the literal `false`. Gate 1 is skipped only because there is no decomposition to quarantine (ADR-028). Never add a caller-reachable path that clears Gate 2.

Accepted units carry `acceptance_criteria_provenance` with `origin=direct_task`. Criteria are copied verbatim — no trimming, casing, reordering, or renumbering — because the CRAFTS C phase treats them as ground truth.

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
- Reading `caller_id` from the request body instead of the authenticated principal lets any caller address another caller's idempotency scope. It is an unknown field in the body for exactly this reason.
- Hashing the raw body rather than the normalized submission makes honest retries conflict on key ordering alone.
- Recording an idempotency key for a *rejected* payload burns the key and blocks the caller's corrected retry.
- Concatenating idempotency scope components without length prefixes lets crafted caller ids and keys collide.
- Adding a field to `UNIT_FIELDS` silently widens the accepted contract; ADR-018 deliberately excludes runtime state, `required_role`, and `complexity`.
- Source-scanning architecture tests must strip comments first — prose describing a forbidden construct is not that construct.
