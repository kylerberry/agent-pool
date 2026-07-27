# Agent Execution — Domain Instructions

## Terms

- **Warm worker pool**: Pre-initialized agent sessions available to accept an attempt contract.
- **Fresh Pi node session**: A new Pi session started for a single attempt, isolated from other attempts.
- **CRAFTS phase**: One of Conceptualize, Render, Assess, Fix, Tighten, or Sharpen executed within an attempt.
- **Phase capability grant**: The model/backend authorization given to a phase based on its role and required capability.
- **Backend fallback**: The policy of degrading to an approved lower-capability backend when the primary backend is unavailable.

## Owned state

- Worker pool membership, health, and availability.
- Active Pi node sessions and their assigned attempt contracts.
- CRAFTS phase sequence state per attempt.
- Phase artifacts emitted by each phase and their validation status.
- Backend fallback decisions and capability-grant records.

## Invariants

- One attempt contract is executed by exactly one active Pi node session at a time.
- CRAFTS phases execute in the approved sequence and produce schema-valid artifacts.
- A phase artifact is forwarded only after it passes schema validation.
- Backend fallback never exceeds the approved model scope.

## Public interfaces

- Accepts **attempt requests** from Orchestration.
- Returns **attempt results** and validated phase artifacts to Orchestration and Verification.
- Exposes worker-pool health and session status queries.
- Manages workspace lifecycle and sandbox execution boundaries.

## Dependencies

- Receives attempt contracts from Orchestration; is DAG-unaware.
- Uses Model Routing and Evaluation for role-indexed backend selection.
- Submits completed artifacts to Verification for tier-1 attestation.
- Uses Codebase Knowledge for workspace context when provisioned.

## Trust boundaries

- Worker sessions are isolated per attempt; filesystem, credentials, and network access are sandboxed.
- Phase artifacts are validated before leaving the session boundary.
- Agent Execution does not modify orchestration state; it returns results and evidence.
- Model-provider credentials remain in policy-free adapter configuration, never in domain code.

## Verification guidance

- Test phase sequencing and artifact validation with isolated attempt contracts.
- Verify worker pool lifecycle, session isolation, and backend fallback paths.
- Confirm schema validation rejects malformed phase artifacts before forwarding.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/raw/specs/orchestrator-spec.md`
- `docs/raw/specs/crafts-phase-artifact-contract.md`

## Footguns

- Sharing a worker session across attempts leaks state and violates isolation.
- Skipping artifact schema validation lets downstream phases consume garbage.
- Hard-coding backend selection bypasses Model Routing and Evaluation policy.
