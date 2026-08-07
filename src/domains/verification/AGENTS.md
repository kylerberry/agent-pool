# Verification — Domain Instructions

## Terms

- **Tier-1 evidence**: Empirical test output, command results, and observable artifacts collected during a phase.
- **Red/green attestation**: A verdict declaring whether a phase's evidence satisfies its acceptance criteria.
- **Suite path/hash history**: The recorded location and content hash of every test suite run.
- **Tier-2 assessment contract**: The audit checklist and maintainability scoring produced by the Assess phase.
- **Composite verdict**: The combined decision across tier-1 and tier-2 evidence for a node.
- **Deterministic verifier**: Runner-owned service that independently verifies a Pool Worker attempt outcome without trusting Worker prose.
- **Pool Proof verdict**: Bounded terminal result for a Stage 1 proof attempt.
- **Fixture verification**: Rerunning the fixture test suite outside Worker control to confirm red/green outcome.

## Owned state

- Tier-1 evidence artifacts and their provenance.
- Red/green attestations per acceptance criterion.
- Suite path/hash history and re-verification records.
- Tier-2 assessment contracts and composite verdicts.
- Pool Proof verdict vocabulary and check lists.
- Bounded structured evidence packages for Pool Proof.

## Invariants

- A verdict is derived only from supplied evidence, never from implementation intent.
- Suite hashes are recomputed and matched before attesting green.
- Re-verification re-runs the same suite path/hash and compares results.
- Verification never mutates implementation code or orchestration state.
- A Pool Proof verdict is derived only from supplied evidence, never from implementation intent or model output.
- The Pool Proof verifier cannot be overridden by Worker prose.
- Only one non-conflicting terminal proof result exists per attempt.

## Public interfaces

- Accepts evidence and phase artifacts from Agent Execution.
- Returns **verdicts** and **evidence packages** to Orchestration and Integration and Delivery.
- Exposes attestation history and re-verification commands.
- Emits **integration re-verification** requests when branch composition changes.
- `createPoolProofVerifier()` returns a verifier that accepts evidence and returns `passed` or `failed`.
- `verifyAttempt()` performs deterministic checks: process binding, workspace containment, commit shape, parent, allowed paths, clean state, fixture outcome, isolation, and duplicate result.

## Dependencies

- Receives artifacts from Agent Execution.
- Reads approved acceptance criteria from the node contract.
- May consult Codebase Knowledge for context but does not reason about it directly.
- None within the product runtime for Pool Proof; consumes evidence from Agent Execution and Harness.

## Trust boundaries

- Evidence is read-only after ingestion; verdicts are append-only attestations.
- No domain can coerce Verification to change a verdict without new evidence.
- Verification results are authoritative inputs to Gate 2 and delivery decisions.
- This domain holds no repository, provider, or deployment credentials.
- Worker diagnostics are untrusted evidence.
- Only bounded, independently produced facts enter the Pool Proof verdict.

## Verification guidance

- Test that verdict logic handles missing, partial, and conflicting evidence correctly.
- Verify suite hash matching and re-verification identity.
- Confirm verdicts are immutable and linked to the evidence that produced them.
- Run `node --experimental-strip-types --test test/verification/*.test.ts`.
- Mutation-test every negative case; removing a check must cause a test to fail.
- The Pool Proof fixture test must be executed in the sandbox, not on the host, and must fail at the base commit before the Worker runs.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/raw/specs/orchestrator-spec.md`
- `docs/raw/specs/crafts-phase-artifact-contract.md`
- `docs/raw/specs/pool-proof.md`
- `docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md`

## Footguns

- Allowing verdict mutation without new evidence destroys auditability.
- Trusting evidence paths without recomputing hashes permits substitution attacks.
- Verification importing orchestration state creates a circular dependency.
- Running the fixture test on the host instead of the sandbox invalidates the isolation claim.
- Using `process.env` in the verifier inherits the Builder environment and can mask credential leakage.
