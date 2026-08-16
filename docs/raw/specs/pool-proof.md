---
audience: repository-builder
subject: product-runtime
status: historical-evidence
created: 2026-08-05
---

# Pool Proof Specification

## Status and authority

This specification is **proposed**. It defines the next bounded build phase but does not authorize implementation, replacement of the approved build DAG, or reset of the local Repository Builder ledger.

> **Historical (non-authoritative for local dispatch).** The Pool Proof build phase is complete
> and its exact-hash governance is retained as immutable evidence only. Current local Repository
> Builder dispatch authority is `docs/raw/context/local-repository-builder-workflow.md`.

Until Kyler approves this specification and its candidate DAG:

- `docs/raw/plans/proposed-build-dag.json` remains the approved plan;
- `.pi/goal-runs/default/ledger.json` remains its local development record;
- no Pool Proof node may begin;
- the existence of this document grants no Pool Worker authority to a Repository Builder session.

## Purpose

Prove the smallest real execution path that makes the pool useful before building more supervisor governance.

The proof must demonstrate that deterministic code can accept bounded direct jobs, allocate ready execution capacity, start isolated headless Pool Worker sessions, collect independently verified repository outcomes, and continue unrelated work after one Worker process fails.

The proof is not a simulation and is not a claim that the complete v1 supervisor, grading pipeline, delivery pipeline, or production operations baseline exists.

## Canonical actor distinction

A **Repository Builder** builds the infrastructure and environment in which Pool Workers can exist and work. It does not become a Pool Worker.

The **Minimal Pool Runtime** and its trusted launcher instantiate Pool Worker processes. A developer may invoke the Pool Proof Harness while building the product, but the invoking Repository Builder session receives no Worker attempt identity or runtime authority.

Actor identity is established once at launch and enforced through process construction and capabilities. Prompt text explains the boundary; it does not create the boundary.

## Deliverables

### Minimal Pool Runtime

Reusable product code providing only:

- bounded direct-job submission into a process-local queue;
- ready Worker-slot allocation;
- minimal durable attempt, builder-routing, and result records;
- fresh per-attempt workspace and Pi session creation;
- launcher-owned Pool Worker identity and resource composition;
- headless Pi CLI process lifecycle;
- trusted repository-tool sandboxing;
- deterministic result collection;
- isolation of unrelated jobs from one Worker-process failure.

### Pool Proof Harness

Proof-only code providing:

- a repository-owned deterministic fixture repository;
- predefined atomic fixture jobs and allowed-path manifests;
- invocation of the real Minimal Pool Runtime;
- one deterministic Worker-process fault-injection seam;
- an independent deterministic verifier;
- a bounded proof report.

The Harness must call the same public Minimal Pool Runtime boundary a later non-fixture caller would use. It must not replace the queue, slot allocator, launcher, Pi process, sandbox, or result path with proof-only simulations during acceptance runs.

## Runtime shape

```text
Pool Proof command
    |
    v
Pool Proof Harness
    |  fixture jobs + expected outcomes
    v
Minimal Pool Runtime
    |-- process-local queue
    |-- durable attempt/routing/result records
    |-- Worker slot A -- fresh attempt --> trusted Pi CLI control process
    |                                      |
    |                                      +--> workspace-confined tools
    |                                            in unprivileged sandbox
    |
    `-- Worker slot B -- fresh attempt --> trusted Pi CLI control process
                                           |
                                           +--> workspace-confined tools
                                                 in unprivileged sandbox

Pool Proof Harness verifier <-- runner-owned result + repository state
```

A Worker slot is persistent ready capacity. A Pi conversation, session directory, actor context, repository sandbox, and workspace are never reused between attempts.

“Warm” in this build phase means that execution capacity is ready to accept work. It does not mean shared conversational context or a persistent model session.

## Fixture boundary

Pool Proof acceptance runs are limited to a deterministic fixture repository owned by this repository. The fixture must:

- be initialized locally from pinned repository content, without GitHub credentials;
- contain all dependencies needed by its verification command or use a pinned build image;
- start from a known commit;
- define atomic jobs with immutable intent, change specification, acceptance criteria, and allowed changed paths;
- provide tests that fail before the intended change and pass after it;
- require no external network access from repository commands.

Passing the fixture does not authorize execution against arbitrary third-party repositories. `agent-pool` dogfooding is the first required follow-up after Pool Proof, but is not a Pool Proof completion criterion.

## Direct-job and attempt boundary

The proof uses the ADR-028 direct-task shape. It does not invoke decomposition or Gate 1.

Each job becomes exactly one topology-free attempt contract. The Worker receives no dependency edges, sibling jobs, queue state, slot state, or global scheduling policy.

Existing direct-intake validation, immutable acceptance-criteria provenance, deterministic attempt projection, and identifier-only queue envelopes should be reused where compatible. Pool Proof does not claim Gate 2 or GitHub delivery completion merely because it reused direct-intake data.

## Process-local queue and slots

The queue exists only in the Pool Proof Runtime process. It needs:

- FIFO submission for the predefined proof jobs;
- exactly one active attempt per slot;
- one slot in Stage 1 and two slots in Stage 2;
- continued dispatch to an available slot after another slot's Worker fails;
- explicit shutdown after all proof jobs reach a terminal proof outcome.

The queue does not survive Runner termination. If the Pool Proof Runtime exits unexpectedly, the proof run fails and is restarted manually. It must not infer completion from partial state.

Persistent queue recovery, leases across controller restart, reconciliation, retries, budgets, branch freezing, and generalized DAG policy are deferred.

## Minimal persistence

SQLite remains the single-writer durable store. The proof persists only enough to inspect what actually ran:

- work, node, attempt, and deterministic job identity;
- the approved builder model selected before dispatch;
- attempt lifecycle timestamps and terminal proof outcome;
- runner-produced result identity;
- commit SHA when one was independently verified;
- deterministic verifier checks and their pass/fail status;
- bounded diagnostic timings and failure code.

Existing attempt creation, builder-routing provenance, topology-free contract projection, and result-identity primitives should be reused rather than duplicated. Existing revision-keyed `phase_artifacts` storage remains dormant: Pool Proof writes no synthetic CRAFTS phases.

No evaluator model or evaluator-routing field is created. Evaluator provenance remains absent until a later grading flow actually invokes an evaluator.

## Headless Pi Worker launch

Every accepted Worker attempt uses a thin Node launcher that starts the pinned Pi CLI in headless mode. SDK embedding is out of scope for Pool Proof.

Before the Pi process starts, the trusted launcher must:

1. rehydrate exactly one stored attempt contract;
2. create a fresh ephemeral workspace and repository sandbox;
3. create a fresh private Pi runtime parent and session directory;
4. resolve exactly one approved builder model through the existing model registry/routing boundary;
5. construct and validate an immutable actor context against independent launcher expectations;
6. verify the exact Pi executable and trusted Worker package/profile;
7. disable ambient project, global, context-file, skill, prompt-template, and extension discovery;
8. explicitly load only the Pool Proof Worker profile and trusted bootstrap extension;
9. start Pi with only the approved model and explicitly granted tools;
10. retain process identity so the Runner can bind termination and result handling to that launch.

Automated tests may inject a fake Pi process adapter. Pool Proof acceptance requires the real pinned Pi CLI and a real approved builder model.

## Worker profile

`packages/worker-harness` gains a separate, fail-closed **Pool Proof builder profile**. It must not weaken or silently replace the existing full CRAFTS profile.

The Pool Proof profile contains only what one direct builder attempt needs:

- the canonical Pool Worker actor instructions;
- one builder prompt/agent surface;
- the trusted bootstrap extension and workspace-confined tools;
- the topology-free attempt contract;
- the execution-context/actor-context contract;
- exact selected-builder model validation;
- bounded result and diagnostic output.

It does not require or invoke:

- evaluator resources or builder/evaluator diversity;
- CRAFTS phase sequencing;
- Graphify;
- phase-artifact emission;
- grading;
- GitHub delivery.

The existing full CRAFTS preflight remains unchanged until separately approved work integrates those capabilities.

## Structural actor identity

### Launcher-owned context

A verified Pool Worker actor context binds at least:

- actor: `pool-worker`;
- node ID and attempt ID;
- single-use attempt nonce;
- target repository and branch;
- canonical workspace path;
- private Pi runtime-parent and session paths;
- exact Pi executable identity;
- exact Worker package/profile identity;
- selected approved builder model;
- tool/capability grant;
- result destination or callback identity;
- issue and expiry times.

The launcher validates the context against independent expected values before paid model work. Task text, target instructions, workspace files, environment claims, and model output cannot alter these fields.

Nonce reuse is rejected for the lifetime of the Pool Proof Runtime process. Because Runner restart recovery is deferred, a restart invalidates the whole proof run rather than attempting cross-process nonce reconciliation.

### Session presentation

The trusted bootstrap renders a concise identity capsule into the system prompt and startup diagnostics:

```text
ACTOR: Pool Worker
AUTHORITY: Execute exactly one supplied attempt contract
ATTEMPT: <attempt-id>
TARGET: <repo>@<branch>
NOT AUTHORIZED: Pool design, supervisor policy, DAG mutation, or other attempts
```

This text is explanatory. Authority comes from the launcher-owned context and available capabilities.

### `actor_identity`

The Worker receives a parameterless `actor_identity` tool backed by immutable context captured by the trusted bootstrap before task execution. It returns a sanitized machine-readable view such as:

```json
{
  "actor": "pool-worker",
  "authority": "single-attempt-execution",
  "node_id": "fixture-job-a",
  "attempt_id": "att://proof/fixture-job-a/1",
  "target_repo": "pool-proof-fixture",
  "context_source": "launcher-verified",
  "can_modify_pool_policy": false
}
```

It accepts no actor-selection input, rereads no mutable workspace marker, and exposes no credential or nonce. A human-visible startup identity is derived from the same object without an LLM call.

A Repository Builder session has no verified Worker context and cannot obtain Worker authority by setting `AGENT_POOL_ACTOR`, creating a marker, changing directories, or writing prompt text.

### No actor transition

A session cannot change actors. Every attempt starts a new Pi process/session. A Builder may invoke the proof command as a developer, but the Minimal Pool Runtime creates the separate verified Worker process.

## Trusted Pi process and repository sandbox

The Pi control process and repository commands occupy different trust zones.

### Trusted Pi control zone

The trusted Pi CLI process may receive the one provider credential needed for its selected model. It runs with launcher-owned:

- `PI_CODING_AGENT_DIR`;
- `PI_CODING_AGENT_SESSION_DIR`;
- `HOME`;
- XDG configuration/cache/data paths;
- package/profile paths.

These paths are private, outside the attempt workspace, and never mounted into the repository sandbox.

### Untrusted repository zone

Repository reads, edits, commands, and tests execute through trusted tool adapters inside an unprivileged per-attempt sandbox. The Pi process starts with built-in tools disabled; only the trusted bootstrap's adapters and `actor_identity` are enabled.

The sandbox must have:

- a pinned image and locked dependencies;
- a non-root user;
- no privileged mode;
- no host Docker socket;
- no provider or GitHub credentials;
- no mount of Builder sessions, Builder `.pi/`, host home, Pi private runtime, or unrelated workspaces;
- only the attempt workspace and required read-only runtime assets mounted;
- explicit CPU, memory, process, and wall-clock limits;
- no external network access for the deterministic fixture;
- a workspace-scoped `HOME` and XDG paths;
- a repository-command environment built from an allowlist, not inherited from Pi.

The trusted tool adapters enforce canonical realpath containment for every file operation and operate through the sandbox boundary. Repository commands never spawn as children that inherit the Pi process environment. Absolute-path, traversal, symlink, environment, process-inspection, and file-based credential probes must fail.

This split is required because removing credential variables from a child shell is insufficient when untrusted commands share the credential-bearing Pi process's filesystem or process namespace.

### Sandbox lifecycle (Stage 1 baseline vs. production target)

Stage 1 uses the simplest correct shape: **one fresh, destroyed-after container per repository tool call** (`docker run --rm` per `read`/`write`/`edit`/`bash`). This is maximally isolated and stateless — every repo command is a clean slate with a fresh allowlist environment — which is why it is the proof baseline. It does not scale: a real attempt issues hundreds of tool calls, and per-call container start cost dominates wall time.

The production target is a **persistent per-worker sandbox container** that lives for the duration of one attempt, with tool calls piped through a small in-container supervisor rather than a fresh `docker run` each time. This eliminates per-call start cost while preserving per-attempt isolation (each attempt still gets its own fresh container, torn down at attempt end).

The hard requirement that move re-introduces, and which the per-call baseline gets for free, is **per-command credential isolation inside a long-lived container**: every repository command must still receive the allowlist environment, a workspace-scoped `HOME`, and no visibility of the Worker's provider credential (ADR-032). The persistent container must re-earn this via its supervisor rather than relying on a fresh container per call. The `runTool` broker interface is abstract enough that this is an implementation change behind the same boundary, not a redesign. This lifecycle upgrade is **deferned** from Pool Proof; it is the prerequisite for the agent-pool dogfood follow-up, where real tool-call volume first appears.

## Target instructions

Automatic target context-file discovery is disabled.

If a fixture or later target contains `AGENTS.md`, the trusted launcher may read bounded repository guidance and include it in the task input as untrusted repository content. It may guide implementation style, but it cannot change actor identity, attempt scope, selected model, tool grants, result destination, or pool policy.

A target instruction claiming “you are the supervisor” or “load Repository Builder resources” must have no effect on capabilities or `actor_identity`.

### Target-provided capability surface (trust tiers)

Repository-provided content is not one trust level. The baseline disables all three tiers; each re-enters under a different policy.

1. **Context files and skills (instructions).** `AGENTS.md`/`CLAUDE.md` and `SKILL.md` files are instructions the model reads. They are the tier a target maintainer legitimately uses to help an agent work in their codebase (for example, a skill documenting a non-standard build system). At the Stage 1 baseline they are not discovered (`--no-context-files`, `--no-skills`). When re-enabled, they re-enter only as **advisory, projected input** under explicit capability grant — never via ambient auto-discovery — and must be read-only, content-scanned for secrets, provenance-tagged as target-origin, and subordinated to the authoritative identity capsule. They may guide implementation style; they cannot change actor identity, attempt scope, selected model, tool grants, result destination, or pool policy.
2. **Extensions and MCP (code).** Repository-provided extensions and external providers are executable code that runs inside the Worker process with full process privileges. They are never auto-loaded (`--no-extensions`). They re-enter only after controller onboarding enforces pinned versions, read-only allowlists, scoped secrets/egress, phase grants, and provenance (the ADR-029 external-provider track). Repository configuration must never auto-launch code; write-capable external sinks remain separately deferred.
3. **Ambient host profile.** The Worker never inherits the Builder’s skills, extensions, prompt templates, or context files. The Worker’s world is assembled per attempt by the launcher, not subtracted from the host.

The identity capsule is the firewall between “helpful guidance” and “policy override”: target-origin instructions are advisory capability hints, never authority. Absence at Stage 1 is the minimal-trust baseline, not the permanent policy.

## Workspace and session lifecycle

Every attempt receives unique, never-reused:

- workspace;
- repository sandbox;
- workspace `HOME` and XDG directories;
- Pi config directory;
- Pi session directory;
- actor context and nonce;
- result identity.

The Harness verifies no state crosses attempts. Raw Pi session/transcript data and sandbox contents are deleted after deterministic verification or terminal failure. The Runner stores only bounded structured proof diagnostics.

Pool Proof does not implement the complete production transcript finalize/redact/persist/verify/index pipeline. Therefore it is not production-ready for arbitrary repositories and does not satisfy the full ADR-032/ADR-026 audit baseline. That work remains deferred; this proof neither weakens nor supersedes those accepted requirements.

## Runner-owned result protocol

The Worker does not declare its own success. Worker prose and tool output are diagnostics only.

The trusted Runner creates the result record and binds it to the launched process and actor context. Before recording `passed`, the verifier must check:

- the expected Pi process exited successfully;
- node ID, attempt ID, and launch nonce match the launched attempt;
- workspace and repository paths remain canonical and contained;
- the expected base commit is unchanged except for the attempt commit;
- exactly one expected commit exists and its parent is the fixture base commit;
- only job-allowed paths changed;
- repository state is otherwise clean;
- the fixture's deterministic test command passes outside Worker control;
- the job-specific observable outcome exists;
- no credential/resource isolation probe succeeded;
- no prior different result exists for the attempt.

A failure of any check records `failed`; it is never repaired by Worker prose.

The verifier must reject:

- result identity derived only from model output;
- absolute, traversing, symlinked, or output-derived artifact paths;
- duplicate results with different contents;
- a commit from another workspace or attempt;
- a claimed pass after process termination or failed fixture tests.

## Stage 1 — Single Worker

Stage 1 implements the smallest vertical path:

```text
fixture direct job
  -> Minimal Pool Runtime
  -> one ready slot
  -> persisted attempt + builder routing
  -> fresh verified Pool Worker
  -> real approved builder model
  -> sandboxed repository change
  -> commit
  -> independent deterministic verification
  -> persisted proof result
```

Stage 1 passes only when one real headless Pi CLI Worker changes the fixture repository and the Runner-owned verifier accepts the result. Fake process adapters qualify unit/integration tests, not the proof run.

No Stage 2 implementation begins until Stage 1 evidence passes.

## Stage 2 — Minimal pool and failure isolation

Stage 2 adds:

- two persistent ready Worker slots;
- three queued fixture jobs;
- a fresh Pi session/workspace/sandbox for every attempt;
- one proof-only deterministic fault directive owned by the Harness.

The Harness injects failure by terminating one real spawned Worker process after launch. It must not substitute a fake Worker or ask a model to fail unpredictably.

Stage 2 passes only when:

- the terminated attempt is recorded as failed;
- the other active job continues;
- the remaining queued job is dispatched and completes;
- both successful jobs pass independent deterministic verification;
- no workspace, session, actor context, result, or repository state leaks between attempts;
- the Pool Proof Runtime remains alive and produces a complete report.

## Diagnostics

Record, but do not gate on:

- enqueue time;
- slot assignment time;
- Pi process start;
- preflight completion;
- first Pi/model event;
- completion and verification time;
- model-reported token/cost data when available.

Pool Proof has no latency target. Performance optimization follows observed evidence rather than a guessed threshold.

## Required negative tests

At minimum, deterministic tests must reject or contain:

- forged `AGENT_POOL_ACTOR` without verified launch context;
- stale, mismatched, malformed, or replayed actor context;
- mismatched node, attempt, repository, branch, workspace, package/profile, model, or result identity;
- ambient Repository Builder skills, `/goal`, `local-craft-*`, global Pi resources, or prior sessions appearing in a Worker;
- target instructions attempting to redefine actor or capabilities;
- provider/GitHub credential access through environment, files, process inspection, or inherited home/config paths;
- absolute path, `..`, symlink, and realpath escapes;
- repository access to the Pi private runtime or unrelated workspace;
- reused workspace, session, nonce, or conversation;
- missing, extra, wrong-parent, or wrong-workspace commit;
- changed paths outside the job manifest;
- Worker prose claiming success while verification fails;
- duplicate or conflicting result submission;
- one terminated Worker crashing the Pool Proof Runtime or blocking unrelated jobs.

## Existing foundations to preserve

Use, adapt, or wrap these foundations rather than replacing them:

- Work Intake direct-task validation, idempotency, and immutable criteria provenance;
- Orchestration work/node import, deterministic attempt/job IDs, topology-free contract projection, identifier-only envelopes, builder-routing provenance, result identity, and SQLite single-writer path;
- Agent Execution execution-context validation, DAG-topology exclusion, credential-environment construction, and capability vocabulary;
- Worker Harness package separation, schemas, JSON validation, approved-model registry, and production full-CRAFTS preflight;
- Orchestrator Harness private runtime-parent, trusted executable identity, minimal-environment, cancellation, and cleanup patterns.

Do not force reuse where an existing component imports deferred policy. In particular:

- do not activate `phase_artifacts`;
- do not fabricate evaluator routing;
- do not require predicted-touch scheduling;
- do not claim current transcript lifecycle code completed the deferred audit pipeline;
- do not weaken the full Worker Harness preflight to make the proof profile pass.

## Explicit deferrals

The following remain outside Pool Proof implementation and acceptance:

- free-form decomposition and Gate 1;
- predicted-touch and Graphify scheduling;
- full DAG failure classification, retries, budgets, escalation, reconciliation, and branch freezing;
- Runner/supervisor crash recovery and durable queue recovery;
- Tier-2 evaluator independence and evaluator provenance;
- full CRAFTS phase sequencing, grading, and runtime use of revision-keyed phase-artifact history;
- builder evaluation calibration;
- integration re-verification and connected-component PR assembly;
- GitHub delivery, Gate 2, and webhook revision loops;
- full transcript retention/indexing, backup/restore, retention policy, operational audit, and production readiness;
- multi-host or multi-tenant operation;
- agent-session reuse and model-session warming;
- latency optimization.

These controls are **not** deferred:

- launcher-established actor identity;
- mutually exclusive Builder and Worker resources;
- provider-credential separation from repository execution;
- workspace/path/capability confinement;
- non-root unprivileged fixture execution with resource limits;
- fresh session/workspace/sandbox per attempt;
- bounded cleanup;
- deterministic result verification;
- real Pi CLI and approved-model acceptance runs.

## Proof completion evidence

Pool Proof is complete only when the repository contains:

1. passing automated tests for the Minimal Pool Runtime, Worker launcher/profile, trusted tool sandbox, Harness, verifier, and negative cases;
2. one retained Stage 1 proof report from a real approved-model run;
3. one retained Stage 2 proof report from real approved-model runs and the injected failure;
4. commit SHAs and verifier evidence for the successful fixture jobs;
5. a concise residual-risk statement that the fixture proof is not production authorization;
6. the named next follow-up: run the same Minimal Pool Runtime against one approved `agent-pool` dogfood task using a separately reviewed job and verifier manifest.

Raw transcripts, provider credentials, and mutable attempt workspaces are not proof artifacts.

## Approval and plan replacement seam

The candidate implementation DAG is stored separately at:

`docs/raw/plans/pool-proof-build-dag.candidate.json`

Pre-approval rules:

- validate its flat ADR-018 shape, references, and topology independently;
- keep it without an `approval` object;
- do not modify the current approved DAG or local ledger;
- stop for Kyler's approval after presenting the candidate hash, nodes, ready frontier, domain-map approval status, and deferred scope.

On explicit approval only:

1. Kyler approves the exact displayed SHA-256 values of the still-unapproved candidate file and this source specification.
2. Keep both files immutable as the approval source. Recompute both hashes and fail if either differs from its approved value.
3. Generate the canonical approved plan from the parsed candidate by adding only the validator-supported `approval` object. Its `notes` must include the exact `candidate_path`, `candidate_sha256`, `source_path`, and `source_sha256` Kyler approved.
4. Mechanically assert that removing `approval` from the generated canonical plan yields the same JSON value as the immutable candidate; no node or top-level plan field may change during activation.
5. Update the canonical goal sequencing and actor/runtime documentation without deleting the deferred v1 objective.
6. Write the generated approved plan to `docs/raw/plans/proposed-build-dag.json` and run `node .pi/scripts/validate-goal-plan.mjs`.
7. Display both hashes: the human-approved candidate hash and the validator-approved canonical plan hash. Use the latter as the `archive-reset` confirmation hash.
8. Archive the existing local goal run and initialize a fresh ledger through the approver-attributed `archive-reset` path.
9. Dispatch only the new ready node in a fresh local CRAFTS slice.

Approval of candidate and source hashes does not approve later edits to either file. The prior approved plan and its ledger history remain recoverable evidence; they are not rewritten to imply Pool Proof was always the plan.
