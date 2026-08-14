---
audience: repository-builder
subject: product-runtime
status: proposed
created: 2026-08-13
---

# Probe Node Workflow Proposal

## Scope

A **probe** is a bounded empirical experiment that resolves a material uncertainty before dependent work begins. It is not limited to API stubs: integrations, platform behavior, data migrations, concurrency, UI feasibility, infrastructure, performance, security boundaries, and model/algorithm quality may all justify one.

This proposal does not add a DAG node type, queue type, phase, subagent, or controller diagnostic role.

## DAG probe

A probe becomes a normal DAG node only when its evidence defines a shared boundary, unlocks multiple nodes, or could invalidate the approved decomposition. Its `intent` is explicitly labelled `Probe: …`; its existing `change_spec`, criteria, and `depends_on` fields describe the hypothesis, required evidence, durable output, and consumers.

The node runs ordinary `craft-pool` CRAFTS. C selects lite or full flow using existing complexity and security rules; a probe is not inherently low-risk. The node must produce a durable, repository-visible, production-safe output that later nodes can use: for example a fixture, contract test, interface, migration rehearsal, benchmark script/result, architecture note, feature-flag seam, or non-routable adapter.

A passing probe confirms the planned boundary and unlocks its dependents only after its node PR is merged and verified on `main`. A probe that disproves the assumed boundary fails with bounded diagnostic evidence; it does not pass merely because it learned something, and it does not unlock implementation work. It follows the governed amendment path.

## Local experiment

A disposable experiment that answers only one node's implementation question stays inside that node as an optional C.2 probe sub-phase. It is not queued, does not create a DAG dependency, and may be deleted. It must not become a hidden route around the node's normal acceptance and CRAFTS gates.

## Deferral

Focused controller-side failure diagnosis is deferred. Existing phase failure artifacts, discovered-work records, human amendment, and bounded retry policy remain the first implementation scope.
