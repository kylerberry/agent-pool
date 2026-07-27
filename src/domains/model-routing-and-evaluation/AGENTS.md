# Model Routing and Evaluation — Domain Instructions

## Terms

- **Provider-normalized model capability**: A capability description independent of any single provider's naming or API.
- **Approved model scope**: The set of models authorized for use by the system.
- **Role-indexed routing**: Selecting a model based on the phase role (e.g., builder, evaluator) and required capability.
- **Eval dataset/run**: A benchmark or empirical measurement used to assess model performance.
- **Empirical threshold**: A performance floor derived from eval runs that gates role assignment.
- **Routing table publication**: The published mapping from roles to approved models and fallbacks.

## Owned state

- Provider-normalized capability registry.
- Approved model scope and backend metadata.
- Role-indexed routing table and fallback chains.
- Eval datasets, run results, and computed empirical thresholds.
- Routing-table publication versions and provenance.

## Invariants

- Every routed model belongs to the approved model scope.
- Routing decisions are deterministic for a given role, capability requirement, and table version.
- Fallback chains degrade capability monotonically and never exceed the approved scope.
- Empirical thresholds are computed from eval runs, not manual assignment.

## Public interfaces

- `getModelForRole(role, capabilityRequirement)` returning a model decision and fallback chain.
- Routing table publication for other domains to consume.
- Eval run ingestion and threshold computation commands.
- Queries for capability coverage and model status.

## Dependencies

- Provides routing decisions to Agent Execution and Verification.
- Does not control DAG flow; Orchestration owns dispatch.
- Uses model-provider clients as policy-free adapters.

## Trust boundaries

- Model-provider credentials are isolated in adapters; this domain sees only normalized capabilities.
- Routing-table changes are versioned and auditable.
- Eval datasets must be representative and free from test-set leakage.
- Fallback decisions are bounded by policy, not by runtime convenience.

## Verification guidance

- Test role-to-model resolution and fallback chains exhaustively.
- Verify empirical threshold computation from sample eval runs.
- Confirm routing-table versions are immutable once published.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/raw/specs/orchestrator-spec.md`

## Footguns

- Hard-coding model names in other domains bypasses the routing table.
- Publishing a routing table without eval evidence creates false capability guarantees.
- Allowing fallback to unapproved models expands the trust boundary silently.
