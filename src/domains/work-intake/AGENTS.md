# Work Intake — Domain Instructions

## Terms

- **Spec**: A structured work definition submitted by a caller, including intent, acceptance criteria, and optional constraints.
- **Direct task**: One caller-authored unit or hand-authored flat DAG that bypasses decomposition and Gate 1.
- **Caller-scoped idempotency**: Repeating the same submission with the same caller/key returns the original result without side effects.
- **Decomposition request**: A request to turn a free-form spec into an ADR-018 flat DAG candidate.
- **Gate 1**: Human approval/amendment checkpoint quarantining model-authored decomposition before orchestration.

## Owned state

- Specs and their intake lifecycle.
- Caller-scoped idempotency keys and resolved submission identities.
- Decomposition requests and candidate DAGs pending Gate 1.
- Gate 1 approval/amendment records and audit timestamps.

## Invariants

- A submission identity is stable for a caller-scoped idempotency key.
- Decomposed specs require deterministic DAG validation and Gate 1 before Orchestration.
- Direct tasks skip decomposition and Gate 1 only; Gate 2 remains mandatory.
- Caller-authored acceptance criteria remain byte-for-byte ordered ground truth with `origin=direct_task`.
- Amendment preserves lineage and re-requires Gate 1.
- A proposed node is the smallest independently verifiable vertical slice: one outcome/oracle, bounded seam, explicit non-goals, and genuine dependencies. Inseparable cross-domain or multi-contract scope requires Gate-1 rationale; it does not widen the ADR-018 emitted five-field node shape.
- `runDecomposition()` emits only ADR-018's five node fields and permits at most one schema-only repair under one invocation deadline. Scope rationale/non-goals are controller-owned proposal-review metadata, not decomposer output or Worker payload.
- Decomposition routing selects the provider-qualified model; the injected invoker executes that exact selection without aliasing or fallback.
- Decomposition provenance is deterministic and immutable, binding sanitized prompt, routing evidence, breadth limits/revision, package identity, and verified Pi executable identity.

## Public interfaces

- `POST /specs`, status, approval, and amendment routes — planned async decomposition/Gate 1 boundary.
- `acceptDirectTasks()` — implemented synchronous domain boundary for one direct unit or hand-authored flat DAG.
- `handleDirectTaskRequest()` — implemented policy-free `POST /tasks` HTTP adapter.
- `runDecomposition()` — implemented deterministic, dependency-injected decomposition service.
- Emits approved work definitions to Orchestration; dispatch remains outside this domain.

## Direct-task path

`acceptDirectTasks()` is synchronous by design: it cannot await a decomposition model. Its result fixes `gate1_required=false`, `gate2_required=true`, and `decomposition_invoked=false` as literal types.

Accepted units carry `acceptance_criteria_provenance` with `origin=direct_task`. Do not trim, case-fold, reorder, renumber, or otherwise rewrite criteria. `direct_task` uses an underscore to match the worker attempt-contract enum.

### Controller-owned projection seam

Accepted units are not worker-facing. Orchestration later projects one ready unit into one DAG-free worker attempt contract:

| Work Intake | Worker attempt contract |
| --- | --- |
| `id` | `node_id`, plus attempt identity |
| `acceptance_criteria: string[]` | `[{ id, text }]` with stable unique IDs |
| provenance `origin` | `criteria_origin.source` |
| provenance `submission_id` | `criteria_origin.source_id` |
| `depends_on` | omitted at dispatch |

Do not build this projection or remove `depends_on` here. Orchestration needs topology for readiness; Agent Execution independently rejects topology in worker payloads. Criterion IDs produced later must remain stable across retries; exact criteria-order preservation makes deterministic index-derived IDs possible.

## Dependencies

- Uses Codebase Knowledge for bounded, revision-bound decomposition context.
- Uses Model Routing and Evaluation for actor-owned fail-closed decomposition selection.
- Does not dispatch nodes; dispatch belongs to Orchestration.
- HTTP remains a policy-free adapter over domain functions.

## Trust boundaries

- Caller jobs, bodies, and idempotency keys are untrusted and strictly bounded.
- Caller identity comes from the authenticated principal, never request-body `caller_id`.
- Gate 1 approvals are authoritative human decisions recorded immutably.
- The decomposition model has no persistence, validation, approval, Gate 1, queue, or dispatch authority.
- This domain never receives worker, orchestration-lifecycle, delivery, or provider credentials.

## Verification guidance

- Run `node --experimental-strip-types --test test/work-intake/*.test.ts`.
- Cover malformed and oversized input, duplicate/missing/self dependencies, cycles, criteria preservation, caller-scoped idempotency replay/conflict/capacity, and no-decomposition behavior.
- Cover exact five-field decomposition output, one-repair/deadline bounds, immutable provenance, exact selected-model binding, actor separation, and hostile input rejection.
- Run `npm test`, `npm run typecheck`, `npm run test:worker`, and orchestrator-harness package tests after integration.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md`
- `docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md`
- `docs/raw/adr/orchestrator/ADR-027-spec-intake-api.md`
- `docs/raw/adr/orchestrator/ADR-028-direct-task-path.md`
- `docs/raw/specs/orchestrator-spec.md`

## Footguns

- Reusing idempotency keys across callers collapses ownership boundaries.
- Hashing raw rather than normalized input makes key-order-only retries conflict.
- Recording a rejected payload under an idempotency key burns the caller's corrected retry.
- Evicting idempotency records silently turns a replay into a new submission; bounded capacity must fail closed.
- Per-field limits multiply; keep aggregate content limits authoritative.
- Adding to `UNIT_FIELDS` widens the accepted contract and can leak controller/runtime state.
- Moving duplicate-ID, referential-integrity, or cycle checks into the decomposer confuses emission validation with downstream deterministic DAG validation.
- Allowing an invoker to select or fallback independently makes routing provenance untrustworthy.
- Making direct intake async weakens the structural no-model-call guarantee.
- Static architecture checks must use AST/module analysis rather than source substrings; pair them with executable boundary evidence.
- `runDecomposition()` receives hostile runtime objects: accept only ordinary or null-prototype own-field records, return bounded `INVALID_JOB` for inherited/class/cyclic inputs, and do not call retrieval or model collaborators first.
- A one-repair ceiling needs an asserted invocation count; a test with an unused third fake response proves nothing.
