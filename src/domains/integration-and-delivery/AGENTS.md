# Integration and Delivery — Domain Instructions

## Terms

- **Branch integration**: Combining changes from one or more completed nodes into a coherent branch.
- **Connected-component commit/PR assembly**: Grouping related node outputs into commits and pull requests.
- **Gate 2**: The final quality gate requiring green composite verdicts before delivery.
- **Review-comment mapping**: Mapping reviewer feedback to the originating node and revision intake.
- **Governed revision intake**: Applying approved revisions back into the work pipeline.

## Owned state

- Integration branches and their connected-component composition.
- Commit and PR assembly state, including linked node outputs.
- Gate 2 status and required verdicts.
- GitHub delivery records, review comments, and revision intake status.

## Invariants

- A branch reaches Gate 2 only with green composite verdicts from Verification.
- Repository commands never hold delivery/provider credentials.
- PR assembly preserves node-level provenance and review-comment traceability.
- Revisions are intake only through the governed path; direct merges are prohibited.

## Public interfaces

- Commands to assemble, update, and close integration branches and PRs.
- GitHub webhook handlers for review comments and revision events.
- Queries for delivery status, PR links, and Gate 2 state.
- Emits revision-intake events to Work Intake/Orchestration.

## Dependencies

- Consumes green composite verdicts from Verification.
- Receives orchestration context for which nodes are ready to integrate.
- Uses GitHub clients and webhook adapters as policy-free infrastructure.

## Trust boundaries

- GitHub webhook inputs are untrusted and must be signature-verified and replay-protected at the adapter layer.
- Repository commands are isolated from delivery credentials.
- Review comments from external callers are mapped but not executed as code changes directly.
- Delivery credentials live only in adapter configuration, never in domain logic.

## Verification guidance

- Test branch assembly logic and connected-component grouping in isolation.
- Verify Gate 2 blocks delivery when verdicts are missing or red.
- Confirm webhook handlers reject invalid signatures and replayed payloads.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/raw/specs/orchestrator-spec.md`

## Footguns

- Running repository commands with delivery credentials conflates read and write trust boundaries.
- Treating unverified webhooks as authoritative can intake attacker-controlled revisions.
- Skipping Gate 2 because a PR looks small bypasses the verification contract.
