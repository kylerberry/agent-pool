# Orchestration — Domain Instructions

## Terms

- **DAG/node lifecycle**: The progression of nodes from ready to running, completed, failed, or resolved.
- **Ready frontier**: The set of nodes whose dependencies are satisfied and that are eligible to lease.
- **Attempt**: A single execution instance of a node contract, tracked with retry and failure-class counters.
- **Lease**: A time-bounded claim granting one agent session the exclusive right to execute an attempt.
- **Governed resolution**: One of five explicit actions (retry, escalate, amend, skip, abort) applied to a failed or stuck node.
- **Attempt provenance**: Append-only builder-routing facts selected for an attempt plus the revision history of phase artifacts. Distinct from lifecycle state, which is mutable.
- **Builder routing resolver**: An injected function supplying the selected builder model for an attempt. Orchestration consumes it as data; it only uses Model Routing's registry validator, never its selection logic.
- **Revision**: A store-assigned monotonic counter per `(attempt_id, phase)`. A phase legitimately repeats within one attempt; each occurrence is a new revision, never an overwrite.

## Owned state

- Approved work definitions received from Work Intake.
- DAG topology, node contracts, and dependency edges.
- Attempt records, retry counters, failure-class counters, and budgets.
- Leases, lease expiration timers, and reconciliation checkpoints.
- SQLite persistence, schema migrations, audit events, deterministic attempt/job identifiers, and scheduling-decision provenance.
- Append-only attempt provenance: `attempt_routing_decisions` (one row per attempt, written at dispatch) and `phase_artifacts` (keyed `(attempt_id, phase, revision)`).
- Escalation/resolution decisions and audit state.

## Invariants

- A node is leased to at most one agent session at a time.
- A node enters the ready frontier only after all its dependencies succeed.
- Orchestration is the sole SQLite writer; lifecycle completion uses expected-version compare-and-set transitions.
- Queue messages contain deterministic identifiers only. The consumer rehydrates SQLite state and projects one deeply immutable, topology-free worker contract.
- Lease generation and token digests fence stale workers and results. Identical result delivery is an audited no-op; conflicting delivery is rejected.
- Predicted-touch serialization is advisory and never rewrites approved dependency edges.
- Retry counters and failure-class counters are monotonic and budget-bounded.
- Governed resolutions are one of the five approved actions and are auditable.
- An attempt cannot exist without canonical builder routing; its routing row is written in the same transaction. Absent or malformed routing rolls the attempt back.
- `attempt_routing_decisions` and `phase_artifacts` are append-only: no row is ever updated or deleted. This is enforced in the schema, not by the absence of a store method.
- Revision is allocated inside the INSERT statement, never by an application-level read-modify-write, so concurrent writers cannot observe the same maximum.
- Orchestration persists only the builder selected for dispatch. Evaluator-execution provenance and Tier-2 independence are deferred to grading and must be recorded at actual evaluator invocation, never inferred from builder dispatch.

## Public interfaces

- Commands and queries for run status and escalation inspection.
- The five governed resolution actions exposed to authorized operators.
- Emits **attempt requests** to Agent Execution, conforming to
  `docs/raw/specs/schemas/pool-worker-attempt-contract.schema.json`. This domain owns the
  projection from a node record (which holds dependency edges) to that payload (which must
  hold none) — see `controller-ready-frontier` acceptance criterion 3.
- Queue consumption validates an identifier-only envelope, rehydrates the stored attempt,
  and projects exactly one immutable, topology-free worker contract.
- Consumes **attempt results** and **verdicts** from Agent Execution and Verification.
- `createAttempt(..., builderRouting)` requires `ResolvedBuilderRouting`. `dispatchReadyFrontier(..., resolveBuilderRouting)` requires a `BuilderRoutingResolver` supplied by the composition root that owns the validated availability snapshot. Resolver outages, invalid routing, and attempt-creation failures return bounded typed skipped outcomes.
- `getBuilderRoutingByAttemptId` returns the persisted builder routing or `null`. Evaluator-execution provenance has no generic attempt-creation field; grading must record it when an evaluator actually runs.
- `recordPhaseArtifact`, `getLatestPhaseArtifact`, and `getPhaseArtifactRevisions` manage C/R/A/F/T/S history with `passed|needs_fix|failed|blocked` outcomes. An artifact must reference a real attempt; deletion is restricted rather than cascaded.

## Dependencies

- Consumes approved work definitions from Work Intake.
- Dispatches attempts to Agent Execution.
- Consumes verdicts from Verification for gating Integration and Delivery.
- Audit-query behavior remains in this domain for v1.

## Trust boundaries

- Agent Execution results are treated as attestations, not as direct persistence mutations.
- Only Orchestration mutates node lifecycle state; no other domain writes orchestration state.
- Webhook or caller inputs never drive resolution actions directly.
- Lease expiry must be defensive: a lost lease can be reclaimed without agent cooperation.
- Startup fails closed for database paths outside the owner-only private runtime root, symlink or non-regular targets, unsafe permissions, failed migrations, and unsupported future schemas.
- Predicted-touch evidence is controller-owned, Gate-1-bound, versioned, and durably recorded. Missing, stale, mismatched, unsupported, or below-policy evidence falls back to optimistic concurrency.
- Builder provenance is controller-written at dispatch and is never writable from a phase artifact, result submission, or queue envelope. Evaluator independence is deferred until grading has a separate record written at evaluator invocation; it must not be inferred from an agent-authored artifact or builder dispatch.
- `artifact_path` is agent-authored. It is stored as a validated workspace-relative locator and is never opened by this domain. Percent-encoded traversal is accepted at storage, so consumers must resolve with realpath containment and must not decode first.

## Verification guidance

- Model ready-frontier calculation, retry policies, and budget exhaustion with property tests.
- Verify lease exclusivity and reconciliation behavior under simulated agent loss.
- Confirm the five resolution actions are exhaustive and mutually exclusive in state transitions.
- Mutation-test append-only and allocation guarantees: remove the mechanism, and the test that claims to protect it must fail. Two real defects in this domain were found this way and none by reading.
- Probe append-only tables from a connection using SQLite's default pragmas, not one this store opened.
- Run `node --experimental-strip-types --test test/orchestration/*.test.ts`, then `npm test`, `npm run typecheck`, and `npm run test:worker`.
- Same-process synchronous `Promise.all` is not SQLite concurrency evidence. Name such tests as ordered multi-handle conflict semantics; reserve concurrency claims for independently gated operations with observed overlap and fencing evidence.
- Architecture import policy uses AST/module checks and must be paired with executable queue, contract, or store behavior—not source substrings or numeric-literal absence.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/raw/specs/orchestrator-spec.md`

## Attempt-payload projection

Dependency edges are read twice — to compute the ready frontier before dispatch, and again at
PR assembly (ADR-015 connected components). They are never handed to a worker. The projection
that drops them is this domain's, and it is not a pass-through: field names and the criteria
shape change across the boundary.

| Node record (ADR-018 emission) | Attempt contract |
|---|---|
| `id` | `node_id`, plus `attempt_id` and `attempt_number` |
| `acceptance_criteria` as strings | `[{ id, text }]`, ids unique and stable |
| `criteria_origin.source` | `"decomposition"` or `"direct_task"` (underscore) |
| `depends_on` | absent |
| — | `prior_failure_context[]` (ADR-026 retry payload) |

Criteria carry stable ids so the phase-artifact contract's `acceptance_criteria_status` can
reference each one. The worker validates this schema strictly and aborts preflight on any
mismatch or extra field, so a drifted payload fails at launch rather than mid-attempt.

## Footguns

- Allowing Agent Execution to write node status directly bypasses Orchestration's lifecycle invariants.
- Reclaiming a lease without idempotency checks can duplicate attempts.
- Mixing audit-query policy with runtime dispatch policy can create hidden coupling.
- Passing a node record straight through as an attempt payload leaks dependency edges to a
  DAG-unaware worker; the worker's topology sweep will abort the launch, but the defect is here.
- Inventing an attempt-payload shape instead of conforming to the attempt-contract schema
  produces a launch-time preflight abort with no useful diagnosis at the worker end.
- `BEFORE UPDATE` and `BEFORE DELETE` triggers alone do **not** make a SQLite table append-only. `INSERT OR REPLACE` resolves a conflict by deleting the existing row, and SQLite fires `BEFORE DELETE` for that implicit delete only when `recursive_triggers` is on — which is off by default. Without a `BEFORE INSERT` conflict guard, `INSERT OR REPLACE` rewrites a recorded row straight through both triggers.
- `PRAGMA recursive_triggers` cannot carry a persistence guarantee: it is per-connection, so it constrains only connections this store opens while every other writer inherits the default. Any invariant that must hold against all writers belongs in the schema.
- Allocating a revision with `SELECT MAX(...)` followed by a separate `INSERT` is a read-modify-write race. Allocate inside the INSERT (`INSERT ... SELECT COALESCE(MAX(revision), 0) + 1 ...`) so the invariant does not depend on transaction-mode discipline that no in-process test can constrain.
- A `Promise.all` over store methods does not test concurrency. `node:sqlite` is synchronous and these methods contain no `await`, so the calls serialize and such a test passes even with the mechanism removed.
- Importing Model Routing to select or reorder a decision inverts the dependency. Take an injected resolver instead; Orchestration may only validate supplied IDs against the canonical registry, so a missing wiring yields a typed skipped result rather than fabricated runtime evidence.
- Strict boundary validators must require own data properties for every accepted required or optional field. Inherited values, class instances, and attacker-controlled prototype chains must not satisfy validation; null-prototype records with own data fields remain valid.
