---
audience: repository-builder
subject: development-harness
---

# Goal: Build the Agent Pool and Supervisor Orchestrator

Build this repository into the v1 self-hosted agent-pool and supervisor-orchestrator system described by its canonical specifications and ADRs. Work autonomously within the constraints below. Treat the linked raw sources as authoritative; do not restate, weaken, or silently reinterpret their decisions.

## 0. Current phase: Pool Proof complete; functional deployment proposed

The exact-hash two-node Pool Proof in `raw/specs/pool-proof.md` is complete. Its canonical plan, ledger history, retained Stage 1/2 reports, and sandbox-lifecycle report remain immutable evidence. No Pool Proof node is ready or reopened.

The next proposed build phase is the unapproved direct-task-first functional deployment in `raw/specs/functional-pool-deployment.md`, with 17 ADR-018 nodes at `raw/plans/functional-pool-deployment-dag.candidate.json` and separate ADR-035 review metadata. It begins with the bootstrap policy plus exact GLM-5.2 qualification, runs GLM-5.3 qualification and the parameterized runner concurrently, performs one bounded Agent Pool credential-strip dogfood task, and then builds the production direct-task service, the CRAFTS artifact ledger and full phase conductor, Tier-1/Tier-2 grading, the governed failure/retry lifecycle with budget, discovery, and recovery branches, accepted ADR-015 component PR assembly behind GitHub Gate 2, the single-host operations baseline, and finally the sole release-convergence proof. After the bootstrap node, GLM-5.3 qualification, the controller branch, and the delivery branch expose safe parallelism; `functional-pool-release-convergence` is the only release claim.

Until Kyler approves the exact candidate and source hashes, `raw/plans/proposed-build-dag.json` remains the completed authoritative plan, the ready frontier is empty, and no candidate node may dispatch.

Free-form decomposition/Gate 1, Graphify/predicted-touch scheduling, agent-assisted probe implementation, eval calibration, ADR-037/038, and broader v1 hardening remain post-launch work. A Repository Builder creates and activates this infrastructure; it never becomes a Pool Worker.

## 1. Product objective

Build a self-hosted personal daily-driver and portfolio system for Kyler Berry. It accepts a free-form feature specification, turns it into an approved DAG of verifiable coding work, dispatches ready nodes to a warm pool of agents, grades each result, and produces reviewable GitHub artifacts with a durable audit trail.

The canonical objective, user, problem statement, and design priorities are in:

- [Supervisor Orchestrator — Consolidated Specification](raw/specs/orchestrator-spec.md)

v1 is for Kyler alone. It is not an external multi-tenant SaaS product.

## 2. Functional requirements

The complete v1 ultimately implements every behavior defined by the canonical specifications and ADRs, including:

- free-form spec intake, structured decomposition, mechanical DAG validation, persistence, and human approval before dispatch;
- node-level queue dispatch to the warm pool, dependency-aware readiness, failure containment, retry/budget handling, and human escalation actions;
- CRAFTS intra-node execution using the explicitly loaded `packages/worker-harness` `craft-pool` skill and runtime phase agents;
- deterministic tier-1 evidence gates, independent tier-2 assessment, red/green test evidence, test-suite hashing/re-verification, and audit records;
- provider-agnostic model access, role-indexed routing, and the builder-first eval harness;
- connected-component PR assembly, GitHub delivery, and revision-loop behavior;
- the required retrieval modes and retained failure-context/transcript-index behavior.

Read and implement from these direct sources rather than relying on summaries:

- [Supervisor Orchestrator — Consolidated Specification](raw/specs/orchestrator-spec.md)
- [ADR-001 through ADR-039](raw/adr/orchestrator/)
- [CRAFTS Phase Artifact Contract](raw/specs/crafts-phase-artifact-contract.md)

## 3. Non-functional requirements

### Reliability and error handling

Implement the durability, retry ceilings, per-node/per-DAG budget limits, escalation, failure containment, re-verification, auditability, and failure-context behavior required by the linked specification and ADRs.

No formal numeric uptime or latency SLO is required for v1. The system must instead make failures observable, preserve recoverable state and evidence, and fail safely rather than silently continuing.

### Security

Use a personal-service baseline: authentication, authorization, least privilege, secret handling, dependency hygiene, auditability, safe defaults, and explicit trust-boundary enforcement. Apply the project CRAFTS policy's mandatory security-review triggers. No formal certification target is required for v1.

### Accessibility, browser support, and mobile responsiveness

v1 is CLI/API/webhook operated. No browser UI, browser-support matrix, accessibility target, or mobile-responsive interface is in scope unless required later by an approved specification change.

### Performance

Meet only the capacity, concurrency, cost, and execution constraints defined in the canonical orchestrator specification. Do not invent latency or throughput targets without approval.

## 4. Architecture constraints

- Follow the deterministic-controller boundary in [ADR-001](raw/adr/orchestrator/ADR-001-deterministic-controller-vs-agentic-orchestrator.md): models operate only at named checkpoints; code owns control flow, policy enforcement, and state transitions.
- Honor every architecture, persistence, orchestration, grading, routing, retrieval, retry, audit, slicing, amendment, delivery-status, and probing decision in [ADR-001 through ADR-039](raw/adr/orchestrator/). Proposed/deferred ADR-037 and ADR-038 are not implementation authority.
- Use the framework, language, infrastructure, API, storage, and integration constraints specified in the canonical orchestrator specification; do not introduce substitutes without an approved ADR.
- Organize application code as bounded domains under `src/domains/<domain>/`. Each domain owns local business rules and a canonical `AGENTS.md`; its sibling `CLAUDE.md` contains only `@AGENTS.md`. See [Domain-Driven Documentation Convention](raw/context/domain-driven-documentation-convention.md).
- Read `AGENTS.md`, `docs/AGENTS.md`, `docs/wiki/index.md`, relevant wiki pages, and then exact raw sources before non-trivial work.
- Launch each DAG node as a fresh Pool Worker Pi session with the explicitly loaded `packages/worker-harness`, `pi-subagents`, the original unit payload, a trusted execution-context marker, and explicit model/tool grants. Normal implementation nodes conduct CRAFTS sequentially. Only an explicitly approved, controller-tagged ADR-039 probe may use the post-launch one-call probe profile; a model cannot self-select that exception.
- Before implementation, complete ADR-034's human-approved domain-discovery gate and create each initial domain's instruction files.
- Pin and preflight Pool Worker capabilities from `packages/worker-harness/config/runtime-versions.json`. The approved target scope is seven exact models: Luna/Terra/Sol, GLM-5.2/GLM-5.3, and Kimi K2.7 Code/Kimi K3. Z.ai models remain ineligible until qualified; Moonshot is fallback-only; do not select Anthropic or any unlisted model. Local `.pi/` routing applies only to Repository Builders.
- The CRAFTS S — Sharpen phase maintains durable domain `AGENTS.md` guidance and affected wiki pages. Canonical requirements/decisions are recorded in `docs/raw/` first; omit transient implementation noise.

## 5. Final-v1 acceptance criteria

These criteria define complete v1, not the current Pool Proof phase. The final implementation is complete only when all of the following are objectively demonstrated:

1. Every applicable requirement in [the orchestrator specification](raw/specs/orchestrator-spec.md) is traced to implementation, automated verification, or an explicitly documented deferred item approved by Kyler.
2. Every ADR has either an implementation trace or a documented statement that it is a future-phase decision; no implementation contradicts an ADR without a newly approved ADR.
3. The initial bounded-domain map is human-approved and every implemented domain has its required `AGENTS.md` and pointer-only `CLAUDE.md` before feature code is added.
4. A free-form spec can be decomposed into a mechanically validated flat DAG, persisted, human-approved, and dispatched only as ready node-level jobs.
5. The controller enforces configured retry, failure-class, budget, escalation, branch-freezing, idempotency, and startup-reconciliation semantics, with durable SQLite audit evidence.
6. A node proves red-before-green tier-1 evidence, persists attested suite/environment/commit data, passes required deterministic checks, receives an independent tier-2 assessment, and records the composite result.
7. The CRAFTS execution path preserves upstream acceptance criteria, enforces builder/evaluator model diversity or fails closed, and emits schema-valid phase artifacts including failure context.
8. At least one end-to-end fixture demonstrates dispatch through GitHub-artifact delivery, including audit records, grading evidence, and a reviewable output.
9. Tests cover success paths, duplicate delivery, crash reconciliation, failure/retry/escalation paths, dependency freezing, re-verification/integration failure, budget exhaustion, and human resolution actions required for v1.
10. Automated linting, type checking, unit/integration tests, and specified static/security checks pass in the pinned reproducible worker environment.
11. Domain boundaries are respected, each implemented domain has local `AGENTS.md` and pointer-only `CLAUDE.md`, and S-phase updates retain durable knowledge in the wiki/raw source structure.

## Delivery behavior

Work in small, reviewable vertical slices. A DAG node is the smallest independently verifiable outcome that preserves correctness, not the smallest edit: state one outcome/oracle, bounded seam, explicit non-goals, and genuine dependencies. Split independently acceptable outcomes and unrelated cleanup, refactoring, documentation, or follow-on capability work. Cross-domain or multi-contract work needs a recorded rationale that the outcome is inseparable.

A Worker never expands its approved node. It may report bounded discovered work; the controller classifies it as adjacent backlog, a correctness/security blocker, or an ADR-024 amendment candidate. Only renewed human Gate 1 approval may alter unmet DAG topology; passed work and evidence remain immutable.

Keep one writer per active worktree unless deliberately using isolated worktrees. Run the relevant verification after every meaningful slice. Stop and ask Kyler before making an unapproved product, security, architecture, cost, or scope decision. At completion, provide a concise evidence-backed summary: changed files, verification commands/results, ADR/spec traceability, residual risks, and remaining approved follow-up work.
