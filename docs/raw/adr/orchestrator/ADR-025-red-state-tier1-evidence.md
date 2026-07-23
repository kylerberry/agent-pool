# ADR-025: Red-State Evidence — The Test Suite Must Prove It Can Fail

**Status:** Accepted
**Amends:** ADR-004 (tiered grading), ADR-017 (suite storage/verification); binds the craft-pool skill's R phase

## Context

Adversarial review named the untested-oracle risk: C authors the tier-1 test suite, and a syntactically valid but tautological suite (one that always passes) would let the builder ship broken logic through a green gate. The existing mitigation — A audits the suite against the original criteria (craft-pool guarantee 2) — is a model judgment, and LLM judges are biased toward blessing code that already cleared deterministic gates. The tautology class needs a deterministic kill, not a judge.

## Decision

**Red-state evidence is a tier-1 requirement.** The R phase's TDD loop is enforced, not advisory: before implementation, the suite (or each new test) must be executed against the pre-change tree and **demonstrated failing**, with the red-run output captured as part of the node's tier-1 evidence. The grading contract becomes: red on pre-change tree → green on post-change tree. A suite that cannot produce a red state is mechanically rejected at tier 1 — no model judgment involved.

Recorded evidence per attempt: red-run output (pre-change), green-run output (post-change), both tied to the suite content hash (ADR-017) in the audit trail.

## Consequences

Tautological/always-pass suites die deterministically; the tier-1 oracle becomes self-checking (it must first prove it can say no). A's suite-audit mandate remains as the semantic layer (does the suite encode the criteria), now backed by a mechanical floor beneath it. Residual risk — tests that red/green correctly but encode the wrong behavior — remains A's job and, longer-term, mutation testing's (deferred; noted in open items). Cost: one extra suite execution per node attempt, negligible against model-call costs.
