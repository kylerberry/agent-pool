# Model Routing and Evaluation — Domain Instructions

## Terms

- **Approved model**: One exact provider-qualified ID in the active canonical registry. The current implementation has the legacy five-model registry. The proposed target adds `zai/glm-5.2` and `zai/glm-5.3`; neither is active or eligible before approved-plan activation and real qualification.
- **Availability snapshot**: A strictly validated caller-provided set of currently usable approved models.
- **Routing policy**: A versioned, actor-scoped mapping of roles to approved primary and fallback models.
- **Routing decision**: Immutable, credential-free evidence of a deterministic role selection.
- **Eval-derived publication**: A validated future policy replacement with `status=eval-derived`; it does not make bootstrap ranks empirical by itself.

## Owned state

- Active exact-model registry and capability policy. The proposed migration replaces the legacy unique total rank with tie-capable tiers; array position is never capability evidence.
- Strict worker and orchestrator bootstrap-policy parsers/loaders.
- Validated availability snapshots, role routing, and builder/evaluator pair selection.
- Provider-neutral injected adapter registry and public decision/error projections.

## Invariants

- Only approved provider-qualified IDs may enter policies, availability, adapters, or decisions.
- A malformed availability snapshot fails closed; an unavailable explicit model never falls back.
- Builder/evaluator selection is atomic and distinct. The evaluator is never lower tier, prefers a higher qualified tier, and may use a tied different model only when no higher qualified evaluator is available.
- The approved target policy makes Moonshot fallback-only in bootstrap and eval-derived policies. After activation/qualification, building bootstraps GLM-5.2→Kimi K2.7 Code; ADR-039's post-launch probing route is GLM-5.3→Kimi K3. Until node 1 passes, current five-model/unique-rank files remain legacy implementation state, not evidence that the target is active.
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
- Do not treat bootstrap capability tiers as empirical evaluation results or force false uniqueness between tied models.
- Do not add a model, provider, alias, or fallback outside the approved exact registry; approval alone does not make a Z.ai model eligible before qualification.
- Do not allow availability, eval score, explicit requests, or fallback handling to promote Moonshot to primary.
- Adapter tests must invoke hostile provider output and assert that routing remains authoritative; a fixture property such as `policyOverride` is not evidence by itself.
- Keep split tests organized by production seam (availability, role selection, pair selection, evidence), with shared fixtures that register no tests.

## Relevant sources

- `docs/raw/adr/orchestrator/ADR-007-provider-agnostic-model-interface.md`
- `docs/raw/adr/orchestrator/ADR-009-empirical-routing-threshold.md`
- `docs/raw/adr/orchestrator/ADR-020-role-indexed-routing-table.md`
- `docs/raw/adr/orchestrator/ADR-021-eval-scope-builder-first.md`
- `docs/raw/adr/orchestrator/ADR-039-agent-assisted-probe-execution.md`
