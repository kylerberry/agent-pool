# ADR-028: Direct Task Submission — Bypassing Decomposition for Known-Shape Work

**Status:** Accepted
**Relates to:** ADR-003 (Gate 1 quarantine), ADR-027 (spec intake API), ADR-010 (node dispatch)

## Context

ADR-027's `POST /specs` path applies fixed ceremony regardless of work size: a decomposition model call, a Gate 1 approval, dispatch, and a Gate 2 PR review. For a one-line config change that is a model call and two human gates to approve that one task is, in fact, one task — ceremony carrying no information. Nothing structurally breaks (the decomposer would emit a single-node DAG), but the overhead is high enough that the system stops being reached for on small work, which quietly defeats the dual-use goal: most personal daily-driver work is one well-scoped task, not a feature to carve.

Intra-node scaling is already handled (CRAFTS routes full-vs-lite on C's complexity report). The gap is orchestrator-level.

## Decision

Add a **direct task path** that skips decomposition and Gate 1:

- **`POST /tasks`** — accepts one unit (`change_spec`, `acceptance_criteria`, repo/branch) and enqueues it straight onto the node queue as a normal node job.
- **Multi-unit variant** — the same endpoint accepts an array of units with `depends_on` edges: a **hand-authored DAG**. This skips the *model* decomposition, not the DAG machinery. Mechanical validation (ids, cycles, referential integrity) still runs; Gate 1 is optional here (the human authored the topology, so approving their own structure is redundant — but it remains available for a submitted DAG a human wants to re-read before dispatch).

Everything downstream is unchanged: CRAFTS executes the node, tier-1/tier-2 grade it, the audit trail records it, PR assembly runs, and **Gate 2 (PR review) remains mandatory**.

**Why skipping Gate 1 is principled, not a shortcut:** Gate 1 exists specifically to quarantine decomposition's non-determinism (ADR-003 — a model call plus retrieval index state). Where there is no decomposition, there is nothing to quarantine. The gate that reviews actual generated code — Gate 2 — is untouched. Nothing load-bearing is lost.

## Consequences

The system becomes proportionate to the work: one-line fixes cost one node's worth of pipeline; features cost decomposition plus approval. This is what makes it usable as a daily driver rather than a heavyweight feature pipeline, which the dual-use goal requires. The hand-authored-DAG variant also matches how CRAFTS has been run manually to date (the human decomposes, the machine executes) — making that an explicitly supported mode rather than an unrepresented workflow.

Codebase-size scaling is a separate, weaker axis and is **not** addressed here: decomposition quality on large unfamiliar repos depends on code-graph retrieval, the least-validated part of the design (ADR-022 notes the LLM-wiki ~200-file ceiling and directory-index mitigation). Small-to-mid repos are within the design's demonstrated range; very large monorepos are unproven and should be described as such rather than claimed.
