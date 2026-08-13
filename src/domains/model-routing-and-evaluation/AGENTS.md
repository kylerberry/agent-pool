# Model Routing and Evaluation — Domain Instructions

## Terms

- **Approved model**: One of the five exact provider-qualified IDs in the frozen registry.
- **Availability snapshot**: A strictly validated caller-provided set of currently usable approved models.
- **Routing policy**: A versioned, actor-scoped mapping of roles to approved primary and fallback models.
- **Routing decision**: Immutable, credential-free evidence of a deterministic role selection.
- **Eval-derived publication**: A validated future policy replacement with `status=eval-derived`; it does not make bootstrap ranks empirical by itself.

## Owned state

- Exact approved-model registry and canonical capability ordering.
- Strict worker and orchestrator bootstrap-policy parsers/loaders.
- Validated availability snapshots, role routing, and builder/evaluator pair selection.
- Provider-neutral injected adapter registry and public decision/error projections.

## Invariants

- Only approved provider-qualified IDs may enter policies, availability, adapters, or decisions.
- A malformed availability snapshot fails closed; an unavailable explicit model never falls back.
- Builder/evaluator selection is atomic, distinct, and the evaluator capability is never lower.
- Routing evidence is allowlisted, deeply immutable, credential-free, and defensively serialized.
- The worker bootstrap owns worker roles only; the orchestrator bootstrap owns decomposition only.
- Eval-derived publications are actor-scoped, source-bearing, `status=eval-derived`, and cannot expand approved scope.

## Public interfaces

- `validateAvailability()` validates a complete availability snapshot.
- `selectForRole()` and `selectBuilderEvaluatorPair()` produce fail-closed routing outcomes.
- Source-bound worker/orchestrator bootstrap loaders read their actor-owned fixtures.
- Eval-publication loaders and `validateRoutingPolicyPublication()` validate future replacement policies.
- `InjectedAdapterRegistry` dispatches an already-selected canonical model without choosing routing policy.

## Dependencies

- Serves Agent Execution and Verification with routing decisions.
- Orchestration owns dispatch and persistence; this domain exposes immutable evidence only.
- Provider clients remain injected policy-free adapters.

## Trust boundaries

- Bootstrap/publication JSON and availability data are untrusted until strict validation passes.
- Credentials, provider payloads, and raw provider exceptions never cross into routing policy, public failures, or evidence.
- Worker and orchestrator package ownership is enforced by actor-specific loaders and role schemas.

## Verification guidance

- Run focused tests: `node --experimental-strip-types --test test/model-routing-and-evaluation/*.test.ts`.
- Run regressions: `npm test`, `npm run typecheck`, and `npm run test:worker`.
- Test hostile availability/policy input, explicit fail-closed behavior, immutable evidence, pair invariants, actor separation, and adapter error redaction.

## Footguns

- Do not load a generic production fixture in place of actor-bound policy loaders.
- Do not propagate provider exception text or payloads into public routing errors.
- Do not treat bootstrap capability ranks as empirical evaluation results.
- Do not add a model, provider, alias, or fallback outside the approved registry.
- Adapter tests must invoke hostile provider output and assert that routing remains authoritative; a fixture property such as `policyOverride` is not evidence by itself.
- Keep split tests organized by production seam (availability, role selection, pair selection, evidence), with shared fixtures that register no tests.

## Relevant sources

- `docs/raw/adr/orchestrator/ADR-007-provider-agnostic-model-interface.md`
- `docs/raw/adr/orchestrator/ADR-009-empirical-routing-threshold.md`
- `docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md`
- `docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md`
