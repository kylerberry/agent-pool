# ADR-035: Minimal Coherent DAG Nodes

**Status:** Accepted
**Relates to:** ADR-003 (gated checkpoint), ADR-010 (node-level dispatch), ADR-018 (decomposition emission schema), ADR-025 (red-state evidence)

## Context

ADR-018 constrains the shape of a node but does not define how much work a node may contain. Without a slicing rule, a decomposition can combine independently dispatchable outcomes, unrelated cleanup, or follow-on capability work into one long-running Worker session. That hides failure causes, weakens retry and budget boundaries, serializes work unnecessarily, and lets a node silently expand after approval.

The target is not the smallest code edit. Artificially splitting one correctness outcome across a contract boundary creates unsafe intermediate states and integration churn. The target is the smallest **independently verifiable vertical slice** that preserves correctness.

## Decision

Every proposed DAG node represents exactly one independently verifiable outcome. It must state:

1. one observable controller or product outcome;
2. one primary invariant and an acceptance oracle that can run without an uncommitted sibling node;
3. a bounded production seam and blast radius;
4. explicit non-goals; and
5. dependencies only on work genuinely required for that outcome.

A node must be split when it contains two outcomes that can be accepted independently, bundles a refactor/cleanup/documentation change not required to establish its outcome, or relies on later node work to make its own acceptance meaningful.

A node may cross domains, change more than one durable contract, or require multiple acceptance suites only when those changes are inseparable for one correct observable outcome. The proposal records a concise scope rationale for each such **exceptional** node in an optional sidecar; ordinary nodes need no scope metadata. It is a Gate 1 review requirement, not permission to broaden the node after approval.

ADR-018’s emitted node schema remains exactly five fields. Scope rationale and non-goals are proposal-review metadata keyed to a node ID; they are not Worker payload, runtime state, or model-authoritative topology. A proposal validator must mechanically validate the optional exceptional-only sidecar when present (repository-contained regular file, plan-node-ID subset, concise non-empty rationale per exceptional node) and surface cross-domain/contract/suite exceptions for Gate 1 review. It cannot mechanically prove minimality; that remains an explicit human approval judgment.

Once Gate 1 approves a DAG, a Worker executes only the approved node outcome. Newly identified work follows ADR-036; it is not folded into the active attempt.

## Consequences

DAG proposals gain a clear slicing rubric. Reviews can distinguish a coherent vertical slice from scope drift, while preserving necessary end-to-end changes. Smaller nodes yield more useful attempts, retries, budgets, evidence, and parallelism.

This decision creates a future Work Intake/proposal-validation unit: persist proposal scope metadata, validate its required fields, expose review exceptions, and add decomposition/approval tests. It does not authorize changing the current runtime node schema or silently reslicing an approved DAG.
