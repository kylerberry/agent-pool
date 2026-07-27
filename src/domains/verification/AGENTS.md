# Verification — Domain Instructions

## Terms

- **Tier-1 evidence**: Empirical test output, command results, and observable artifacts collected during a phase.
- **Red/green attestation**: A verdict declaring whether a phase's evidence satisfies its acceptance criteria.
- **Suite path/hash history**: The recorded location and content hash of every test suite run.
- **Tier-2 assessment contract**: The audit checklist and maintainability scoring produced by the Assess phase.
- **Composite verdict**: The combined decision across tier-1 and tier-2 evidence for a node.

## Owned state

- Tier-1 evidence artifacts and their provenance.
- Red/green attestations per acceptance criterion.
- Suite path/hash history and re-verification records.
- Tier-2 assessment contracts and composite verdicts.

## Invariants

- A verdict is derived only from supplied evidence, never from implementation intent.
- Suite hashes are recomputed and matched before attesting green.
- Re-verification re-runs the same suite path/hash and compares results.
- Verification never mutates implementation code or orchestration state.

## Public interfaces

- Accepts evidence and phase artifacts from Agent Execution.
- Returns **verdicts** and **evidence packages** to Orchestration and Integration and Delivery.
- Exposes attestation history and re-verification commands.
- Emits **integration re-verification** requests when branch composition changes.

## Dependencies

- Receives artifacts from Agent Execution.
- Reads approved acceptance criteria from the node contract.
- May consult Codebase Knowledge for context but does not reason about it directly.

## Trust boundaries

- Evidence is read-only after ingestion; verdicts are append-only attestations.
- No domain can coerce Verification to change a verdict without new evidence.
- Verification results are authoritative inputs to Gate 2 and delivery decisions.
- This domain holds no repository, provider, or deployment credentials.

## Verification guidance

- Test that verdict logic handles missing, partial, and conflicting evidence correctly.
- Verify suite hash matching and re-verification identity.
- Confirm verdicts are immutable and linked to the evidence that produced them.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/raw/specs/orchestrator-spec.md`
- `docs/raw/specs/crafts-phase-artifact-contract.md`

## Footguns

- Allowing verdict mutation without new evidence destroys auditability.
- Trusting evidence paths without recomputing hashes permits substitution attacks.
- Verification importing orchestration state creates a circular dependency.
