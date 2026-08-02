# Orchestration — Domain Instructions

## Terms

- **DAG/node lifecycle**: The progression of nodes from ready to running, completed, failed, or resolved.
- **Ready frontier**: The set of nodes whose dependencies are satisfied and that are eligible to lease.
- **Attempt**: A single execution instance of a node contract, tracked with retry and failure-class counters.
- **Lease**: A time-bounded claim granting one agent session the exclusive right to execute an attempt.
- **Governed resolution**: One of five explicit actions (retry, escalate, amend, skip, abort) applied to a failed or stuck node.

## Owned state

- Approved work definitions received from Work Intake.
- DAG topology, node contracts, and dependency edges.
- Attempt records, retry counters, failure-class counters, and budgets.
- Leases, lease expiration timers, and reconciliation checkpoints.
- Escalation/resolution decisions and audit state.

## Invariants

- A node is leased to at most one agent session at a time.
- A node enters the ready frontier only after all its dependencies succeed.
- Retry counters and failure-class counters are monotonic and budget-bounded.
- Governed resolutions are one of the five approved actions and are auditable.

## Public interfaces

- Commands and queries for run status and escalation inspection.
- The five governed resolution actions exposed to authorized operators.
- Emits **attempt requests** to Agent Execution, conforming to
  `docs/raw/specs/schemas/pool-worker-attempt-contract.schema.json`. This domain owns the
  projection from a node record (which holds dependency edges) to that payload (which must
  hold none) — see `controller-ready-frontier` acceptance criterion 3.
- Consumes **attempt results** and **verdicts** from Agent Execution and Verification.

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

## Verification guidance

- Model ready-frontier calculation, retry policies, and budget exhaustion with property tests.
- Verify lease exclusivity and reconciliation behavior under simulated agent loss.
- Confirm the five resolution actions are exhaustive and mutually exclusive in state transitions.

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
