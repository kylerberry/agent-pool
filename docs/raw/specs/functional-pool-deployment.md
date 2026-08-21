---
audience: repository-builder
subject: product-runtime
status: historical-evidence
created: 2026-08-13
---

# Functional Pool Deployment — Direct-Task-First Build Phase

> **Historical (non-authoritative for active dispatch).** This specification and its exact-hash
> approval artifacts (`functional-pool-deployment-dag.candidate.json`, its all-node scope review,
> and `functional-pool-deployment-approval.json`) are retained as immutable evidence of the
> 2026-08-15 activation. They are not active dispatch authority. The active plan remains
> `docs/raw/plans/proposed-build-dag.json`.

## Purpose

Deploy the fastest trustworthy personal version of Agent Pool: authenticated caller-authored direct tasks execute in fresh Pool Workers, pass full CRAFTS and machine grading, survive ordinary single-host interruption, and arrive as reviewable GitHub pull requests behind human Gate 2.

This phase follows the completed Pool Proof. It does not rewrite its ledger, reports, or evidence. The exact completed canonical plan is durably archived at `docs/raw/plans/completed-pool-proof-build-dag.json` with SHA-256 `fe62bd9b156976401f4571aea4fd60bcb512b005927b161e5d3e4610dce2d8e5`; it remains recoverable after the active canonical plan path eventually advances. The activation-time candidate `docs/raw/plans/functional-pool-deployment-dag.candidate.json` at SHA-256 `82cfe59c88b57e5fbcea27ce26d6c2406fea360e8e3025390d920326b01a6b9a` was approved and activated on 2026-08-15; its approval artifacts are retained as immutable evidence.

## Product cut

The first deployed service is **direct-task-first**:

- `POST /tasks` accepts one bounded unit or a caller-authored flat DAG;
- free-form `POST /specs`, model decomposition, and Gate 1 remain deferred;
- full CRAFTS, deterministic Tier 1, independent Tier 2 bootstrap grading, recovery, GitHub Gate 2, and single-host operations are required before the service is called deployed;
- the first Agent Pool dogfood run remains a separately reviewed local-commit proof and does not itself authorize production use.

## Model policy

The approved target Pool Worker scope adds exact models `zai/glm-5.2` and `zai/glm-5.3`. Approval is exact-ID only; it does not authorize Z.ai aliases, future models, or provider wildcards.

Bootstrap capability is tiered, not totally ordered:

| Tier | Exact models |
|---|---|
| lower | `openai-codex/gpt-5.6-luna` |
| standard | `zai/glm-5.2`, `openai-codex/gpt-5.6-terra`, `moonshot/kimi-k2.7-code` |
| high | `zai/glm-5.3`, `openai-codex/gpt-5.6-sol`, `moonshot/kimi-k3` |

Ties are honest bootstrap capability equivalence. They do not claim empirical equality. Model-array position cannot create capability ordering.

Moonshot is fallback-only across every role and policy source. Bootstrap and future eval-derived publications may measure Moonshot but cannot promote a Moonshot model to primary. Every exact Z.ai model remains ineligible until its real Pool Worker qualification passes.

The deployment bootstrap is complete for every active role:

| Role | Primary | Fallback |
|---|---|---|
| node conductor | `openai-codex/gpt-5.6-terra` | `moonshot/kimi-k3` |
| planning | `openai-codex/gpt-5.6-terra` | `moonshot/kimi-k3` |
| building | `zai/glm-5.2` | `moonshot/kimi-k2.7-code` |
| assessing | `openai-codex/gpt-5.6-sol` | `moonshot/kimi-k3` |
| tightening | `openai-codex/gpt-5.6-sol` | `openai-codex/gpt-5.6-terra` |
| sharpening | `openai-codex/gpt-5.6-luna` | `openai-codex/gpt-5.6-terra` |
| failure diagnosis | `openai-codex/gpt-5.6-terra` | `openai-codex/gpt-5.6-sol` |

ADR-039 separately records the post-launch probing route `zai/glm-5.3`→`moonshot/kimi-k3`; node 1 does not implement the unused runtime probing row/profile.

Provider subscription/quota exhaustion is an availability outcome, not evidence of an administrator-configured account cap. Same-attempt fallback retains failed-primary evidence and cost, preserves workspace state, remains bounded, and never turns the fallback into a primary. Explicit unavailable selection still fails closed where policy requires exact execution.

Eval-derived routing is post-launch calibration. The deployed bootstrap must be labeled provisional and retain the evaluator rule: evaluator model differs from the builder and is never lower tier; prefer a higher qualified tier, permit a tied different model only when no higher qualified evaluator is available.

## Seventeen-node critical path

| # | Node | Observable outcome | Binding decisions |
|---:|---|---|---|
| 1 | `deployment-bootstrap-policy-and-glm52-qualification` | Exact GLM-5.2 becomes the qualified active builder primary under tiered, Moonshot-fallback-only routing. | ADR-007/008/020/021/030/032 |
| 2 | `glm53-eligibility-qualification` | Exact GLM-5.3 qualifies at high tier and stays unreferenced by active roles. | ADR-007/020/030/032; ADR-039 probing deferred |
| 3 | `parameterized-agent-pool-dogfood-runner` | One reviewed Agent Pool task can use the real Minimal Pool Runtime without fixture-specific code. | Pool Proof boundary; ADR-028/032/035 |
| 4 | `credential-strip-zai-dogfood` | A real Z.ai Worker removes copied provider credentials and the runner verifies the commit. | Stage 1 owned follow-up; ADR-032 |
| 5 | `direct-task-first-service` | Authenticated direct tasks durably reach real Workers without decomposition. | ADR-010/014/027/028/031/035 |
| 6 | `crafts-artifact-ledger-and-transcript-retention` | Only schema-valid, attempt-bound, append-only phase artifacts with verified transcript objects or `audit_incomplete` are retained. | ADR-014/026; CRAFTS contract; ADR-035 |
| 7 | `full-crafts-phase-conductor` | Production attempts execute the complete governed phase lifecycle with durable artifacts. | ADR-020/026/029/032; CRAFTS contract |
| 8 | `tier1-evidence-attestation` | Every implementation attempt receives an immutable recomputed Tier-1 pass/fail attestation. | ADR-004/017/025 |
| 9 | `tier2-composite-verdict-audit` | Every Tier-1-complete attempt receives one composite verdict and audit chain. | ADR-004/014/017/025/026 |
| 10 | `classified-failure-retry-and-resolution` | Failure classification, branch freezing, and the five governed resolutions form one auditable lifecycle. | ADR-011/012/016/023/024 |
| 11 | `controller-budget-guardrails` | Validated cumulative cost stops nodes and new DAG dispatch at the correct ceiling. | ADR-013 |
| 12 | `discovered-work-quarantine` | Bounded discoveries are classified without topology authority; blockers escalate through node 10. | ADR-024/036 |
| 13 | `queue-and-restart-recovery` | Queue, lease, result, startup, and migration interruptions reconcile idempotently. | ADR-013/023/028/031; ADR-033 recovery semantics |
| 14 | `adr015-component-pr-assembly` | A reverified connected component becomes exactly one provenance-bearing PR awaiting Gate 2; stale-green returns to governed failure handling with no GitHub side effect. | ADR-015/017/031/032; ADR-037/038 deferred |
| 15 | `github-gate2-governed-review` | Only an authorized signature-verified replay-protected human record completes or returns an awaiting PR; comments are inert bounded revision data. | ADR-015/017/031 |
| 16 | `single-host-operations-baseline` | A private pre-release host operates, backs up, restores, and cleans up the stack without credential leakage. | ADR-033 |
| 17 | `functional-pool-release-convergence` | The restored single-host release completes one controlled direct task through Gate 2 with complete traceability. | ADR-014/031/032/033 |

After node 1, nodes 2 and 3 may run concurrently; after node 10, nodes 11 and 12 may run concurrently; after node 9, the controller branch (10–13) and the delivery branch (14–15) may run concurrently; after node 13, node 16 may run concurrently with unfinished delivery work. Node 17 is the sole convergence and release gate.

The candidate contains the exact change specifications and acceptance criteria. ADR-035 scope-review metadata is stored separately and never widens ADR-018's five-field node schema or Worker payload.

## Probe execution decision

Agent-assisted probes are accepted as a post-launch capability, not part of these 17 nodes. A probe resolves a material uncertainty by mocking a boundary, discovering unknowns, and producing evidence that constrains later CRAFTS sessions. It is not normal implementation work and does not run full or lite CRAFTS.

A probe uses one fresh Worker session and one `probing` model call with bounded tools, paths, time, tokens, and cost. It emits a schema-valid evidence artifact containing hypothesis status (`supported`, `disproved`, or `inconclusive`), observations, commands, durable fixtures/contracts/mocks or non-routable seams, assumptions confirmed/rejected, dead ends, artifact hashes, and non-authoritative DAG implications. The deterministic controller validates and persists the artifact; the probe cannot grade, route, dispatch, amend topology, or expand its own scope.

A supported probe may unlock approved dependents after its artifact is durably integrated and verified. A disproved probe preserves useful evidence but blocks the planned dependents and recommends human-governed amendment. An inconclusive probe fails without authorizing speculative work. Future C receives the probe artifact and must identify which conclusions it adopts, what uncertainty is settled, and any contradictory evidence before planning.

Per ADR-020, probing is a distinct model-call role. Bootstrap routing is `zai/glm-5.3` primary and `moonshot/kimi-k3` fallback. Security-sensitive, production-routed, or expanded probe work escalates to normal CRAFTS.

## Delivery decisions

ADR-015 remains authoritative for this phase. A one-node direct task naturally produces one component and one PR. Connected components retain one commit per node and re-verification against the composed head.

ADR-037 remains proposed and deferred: GitHub planning PRs do not accelerate direct-task-first deployment. ADR-038 remains proposed and deferred: node-level mainline integration will be reassessed from real delivery evidence. Node 14 records PR size, branch drift, and integration retries; node 15 records review disposition, dependency-unlock latency, and operator friction for that decision.

## Explicit post-launch work

The deployment excludes, in priority order after launch:

1. agent-assisted probe execution from ADR-039;
2. free-form spec intake, decomposition, mechanical DAG proposal validation, and Gate 1;
3. ADR-035 scope-review enforcement in product Work Intake and ADR-036 amendment input using discovered/probe evidence;
4. repository onboarding, Graphify indexing, and predicted-touch scheduling;
5. builder-first eval calibration and later role-specific eval rows;
6. GitHub review-comment continuation;
7. ADR-037 and ADR-038 reassessment;
8. target-provided capability onboarding, multi-host/multi-tenant operation, formal SLO/on-call, stronger outbox/fencing, and roadmap hardening.

## Approval and activation

> **Activation-time historical wording.** This section preserves the approval gates as they
> read before activation. Kyler's exact-hash approval was then obtained and the 2026-08-15
> activation completed; the approval artifacts are retained as immutable evidence only (see
> the header banner). Nothing in this section is current dispatch authority.

At drafting time this specification and candidate were proposed only. No node was ready and the completed `docs/raw/plans/proposed-build-dag.json` remained authoritative until Kyler approved the exact candidate and source hashes.

Repository Builder tooling then enforced `docs/raw/specs/schemas/functional-pool-deployment-approval.schema.json`. Structural DAG validity is never dispatch authority: dispatcher initialization and archive reset validate and then authorize exact plan bytes before any ledger or archive mutation. The exact completed Pool Proof plan SHA-256 is the sole approval-free case; every other plan requires the complete detached approval chain binding candidate, source, scope review, completed-plan archive, canonical candidate-plus-approval equality, and approver identity/time. Plan markers, paths, symlinks, hard links, path swaps, and governance-file presence cannot select a weaker authorization path. Missing records, generic notes, byte drift, archive drift, scope mismatch, or canonical-plan drift fail before activation. At that time no detached approval record existed, so the candidate remained unapproved until activation; the subsequently recorded detached approval completed the activation, and the approval chain is retained as immutable evidence.

Activation must:

1. display the candidate, source, scope-review, and completed-plan-archive paths/hashes;
2. validate the 17 ADR-018 nodes, topology, and separate ADR-035 scope-review record;
3. obtain Kyler's detached exact-hash approval conforming to the deployment-approval schema;
4. run the tested deployment-approval validator and require exact file-byte matches;
5. generate a canonical approved plan by adding only validator-supported approval metadata;
6. prove removal of that approval object reproduces the approved candidate JSON value;
7. atomically replace the active canonical plan while preserving the tracked completed-plan archive;
8. validate the activated canonical plan;
9. retain the completed Pool Proof plan as historical evidence; and
10. dispatch only the new ready root, `deployment-bootstrap-policy-and-glm52-qualification`.
