# Agent Execution — Domain Instructions

## Terms

- **Warm worker pool**: Ready execution-capacity slots available to accept an attempt contract. A slot may persist; conversational state does not.
- **Fresh Pi node session**: A new Pi process/session started for a single attempt, isolated from other attempts and never reused by a slot.
- **Pool Proof Worker profile**: The approved builder-only `packages/worker-harness` profile used to prove one real direct attempt without evaluator, CRAFTS, Graphify, or grading resources. It does not weaken the separate full CRAFTS profile.
- **Execution context**: The launcher-owned per-attempt marker (`pool-worker-execution-context.schema.json`, v3). Version 3 extends v2 with private Pi runtime/session roots, executable/package/profile identity, the selected approved model, tool grants, and result destination; it binds actor, node, attempt, repository, branch, workspace, and freshness.
- **Freshness expectation**: `issued_at` + `expires_at` + `max_age_seconds`, owned by the launcher and capped by the specification's five-minute ceiling. A launcher may be stricter, never laxer.
- **Attempt contract**: The single DAG-free unit payload a worker executes (`pool-worker-attempt-contract.schema.json`, v1).
- **CRAFTS phase**: One of Conceptualize, Render, Assess, Fix, Tighten, or Sharpen executed within an attempt.
- **Phase capability grant**: The tool/write authorization a phase holds, scoped per phase rather than per container.
- **Backend fallback**: Degrading to an approved lower-capability backend *within the same attempt*; the whole chain is still one attempt against the retry ceiling.
- **Cleanup state**: `ready`, `extracting`, `audit_complete`, `audit_incomplete`.

## Owned state

- Worker capacity-slot membership, health, and availability.
- Active fresh Pi sessions and their assigned attempt contracts.
- CRAFTS phase sequence state per attempt.
- Phase artifacts emitted by each phase and their validation status.
- Backend fallback ledgers: per-backend cost, evidence, and outcome for one attempt.
- Attempt workspace cleanup state and bounded quarantine deadlines.
- Transcript audit records keyed by `transcript_object_id`.

## Invariants

- One attempt contract is executed by exactly one active Pi node session at a time; zero or many contracts fails closed.
- Every attempt receives a fresh launcher-owned context; identity, target, and workspace must match launcher expectations independently of the marker's own claims.
- `max_age_seconds` never exceeds 300, and `expires_at` never outruns the context's own budget.
- No worker-bound payload carries DAG topology at any nesting depth.
- The full production profile executes CRAFTS phases in the approved sequence and forwards only schema-valid artifacts. The explicitly selected Pool Proof profile runs one builder directly and writes no synthetic phase artifact or evaluator provenance.
- A (`A`), Tighten (`T`), and Conceptualize (`C`) hold no write capability. Sharpen writes only into an owner-approved knowledge sink and never creates one.
- Repository commands receive an allowlist-built environment and no provider or GitHub credential — **including file-based ones**. The host `HOME` is never propagated; home-scoped variables and git's config paths are repointed inside a caller-supplied workspace home.
- Startup validates the model scope against the exact five-model set fixed in the specification, held as a constant in the gate. Configuration files agreeing with each other is not evidence: both are mutable and in-repo.
- Backend fallback never leaves the attempt, never exceeds the approved model scope, is bounded at three backends, and accumulates cost and evidence from failed backends as well as the winner. `amount` and `currency` are jointly present or jointly absent.
- Transcript retention runs finalize → redact → hash → persist → verify → index before cleanup. The hash covers the redacted bytes actually persisted, and verification re-reads the stored **bytes** and rehashes them locally — store-reported metadata is not verification.
- `transcript_path` is a transient workspace-relative locator only; the durable reference is `transcript_object_id`.
- Cleanup has no indefinite-retention outcome: an unresolved or failed extraction is destroyed once the bounded quarantine expires, preserving the failure record. `startedAt` must be finite, or the deadline comparison never fires.
- `markAuditComplete()` requires the verified retention record for that attempt. Authorizing destruction is bound to evidence, not to a caller's assertion.

## Public interfaces

- `validateExecutionContext()` binds an untrusted marker to launcher expectations and consumes its nonce.
- `validateAttemptContracts()` enforces exactly one topology-free unit payload.
- `buildRepositoryCommandEnv()` / `buildTrustedOperationEnv()` / `assertNoCredentials()` for credential isolation.
- `getPhaseGrant()` / `phaseHasCapability()` / `authorizeWrite()` for ADR-029 phase scoping.
- `createBackendFallbackLedger()` for same-attempt fallback cost and evidence continuity.
- `retainTranscript()` for the ADR-026 retention pipeline; `createAttemptWorkspaceLifecycle()` for bounded cleanup.

## Dependencies

- Receives attempt contracts from Orchestration; is DAG-unaware.
- Uses Model Routing and Evaluation for approved-model checks and role-indexed backend selection.
- Submits completed artifacts to Verification for tier-1 attestation.
- Uses Codebase Knowledge for workspace context when provisioned.
- The durable transcript object store and audit index are injected interfaces; this domain verifies their results and never assumes success.

## Trust boundaries

- The launcher context, attempt contract, profile selection, and all host environment state are untrusted until preflight and domain validation pass.
- The trusted credential-bearing Pi control process and untrusted repository execution occupy separate zones. Repository tools run through workspace-confined adapters in a credential-free sandbox; environment filtering alone is not sufficient when processes share a filesystem or process namespace.
- Repository commands and generated tests are untrusted code; filesystem, credentials, process visibility, and network access are sandboxed.
- Transcript bytes are untrusted content and are redacted before hashing and persistence.
- The attempt workspace is untrusted once repository code has run and must be destroyed under a bounded deadline.
- Phase artifacts are validated before leaving the session boundary.
- Agent Execution does not modify orchestration state; it returns results and evidence.
- Model-provider credentials remain in policy-free adapter configuration, never in domain code.

## Verification guidance

- Run focused tests: `node --experimental-strip-types --test test/agent-execution/*.test.ts`.
- Run regressions: `npm test`, `npm run typecheck`, and `npm run test:worker`.
- Cover hostile launch contexts (stale, not-yet-valid, replayed, mismatched, oversized), DAG-topology smuggling at depth, credential leakage into repository environments, phase write denial, fallback cost/evidence continuity, transcript step ordering and persistence failure, and bounded unsafe-workspace cleanup.
- `packages/worker-harness/test/preflight.test.mjs` is the runtime-gate counterpart; the two must stay behaviourally aligned.

## P0 follow-up hardening

Implemented here is the ADR-032 baseline. The following remain approved roadmap work and are **not** delivered by this domain:

- content-level secret scanning/redaction (the transcript redactor is an injected interface, not an implemented scanner);
- OS-level default-deny egress for repository commands;
- OS read-only mount/sandbox isolation for attempt workspaces;
- reproducible worker-image smoke attestation;
- cross-launch nonce replay detection, which is supervisor-owned state;
- a spawn helper that mechanically forces every repository command through `buildRepositoryCommandEnv()`.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/ADR-026-failure-context-artifacts.md`
- `docs/raw/adr/orchestrator/ADR-029-agent-tool-surface-and-phase-scoping.md`
- `docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md`
- `docs/raw/specs/orchestrator-spec.md`
- `docs/raw/specs/crafts-phase-artifact-contract.md`
- `docs/raw/specs/schemas/pool-worker-execution-context.schema.json`
- `docs/raw/specs/schemas/pool-worker-attempt-contract.schema.json`

## Footguns

- Treating a persistent capacity slot as a reusable Pi conversation leaks state and violates isolation.
- Running repository commands as ordinary children of a provider-credential-bearing Pi process exposes credentials through environment, files, or process inspection even when the child environment is filtered.
- Skipping artifact schema validation lets downstream phases consume garbage.
- Hard-coding backend selection bypasses Model Routing and Evaluation policy.
- Filtering a credential denylist instead of building from an allowlist fails open on the one variable nobody named.
- Stripping credential *variables* while passing the host `HOME` is not credential isolation: `~/.git-credentials`, `~/.netrc`, `~/.npmrc`, `~/.config/gh/hosts.yml`, and `~/.aws/credentials` are all readable, and `gh auth token` will happily read them.
- Checking that two mutable config files agree is not checking an exact model set; a bad merge or an attacker edits both.
- Discarding failed-backend cost makes the controller enforce its budget ceiling against an under-count.
- Accepting an `amount` with a null `currency` lets an unknown-currency charge be folded into a later currency's total.
- Hashing the raw transcript rather than the redacted bytes makes verification prove the wrong thing; so does trusting store-reported metadata instead of rehashing the bytes the store returns.
- Treating a nonce *format* check as replay protection is a false assurance.
- Any cleanup path that can return "retain" forever reintroduces the ADR-032 failure mode — including a `NaN` deadline, which no `now >= deadline` comparison ever satisfies.
- Advancing cleanup state without retention proof turns a gate into a formality.
- A fresh launcher-owned `PI_CODING_AGENT_DIR` combined with `PI_OFFLINE=1` cannot resolve non-native (host-configured) providers such as `moonshot` — their definitions live in the host `~/.pi/agent/models.json`, not Pi's built-ins. The launcher must carry the selected provider's `models.json` entry (`copyProviderModels`), not only its auth, or the pinned model resolves as unavailable offline.
- Spawning the headless `--print` Pi Worker with an open stdin pipe blocks indefinitely with **zero output** until the wall-clock kill. Always spawn with `stdio: ['ignore', 'pipe', 'pipe']` so stdin is not a pipe.
