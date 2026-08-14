# ADR-018: Decomposition Emission Schema and Emit-vs-Derive Split

**Status:** Accepted — amended 2026-08-13

## Context

The decomposition step (ADR-002) emits the structured DAG the deterministic controller consumes. Its exact per-node payload was undefined, and several candidate fields (`required_role`, `complexity`) turned out to belong elsewhere.

## Decision

The DAG is a **flat list of nodes**, each carrying a `depends_on: [nodeId]` array — not a nested tree. A DAG allows convergence (a node with multiple parents), which a tree cannot represent without duplication; a flat edge list is the honest encoding and is mechanically validatable (all referenced ids exist; no cycles) before dispatch.

**Per-node fields the decomposer emits:** `id`, `intent`, `change_spec`, `acceptance_criteria`, `depends_on`.

**Explicitly not emitted:**
- Runtime state (`status`, `retry_count`, `budget_spent`, test-suite `path`/`hash`) — the controller initializes and owns these. Decomposer emits the *plan*; controller owns the *state*.
- `required_role` — execution profile and model role are controller-owned proposal/runtime policy, not decomposer output. Normal implementation nodes run CRAFTS. ADR-039 permits an approved probe node to use the one-call `probe` execution profile outside CRAFTS without adding a sixth emitted field. A swarm may define a different schema; this one does not carry role for forward compatibility.
- `complexity` — owned by C, not the decomposer. Complexity is a function of implementation effort, discovered firsthand by the phase that reasons about implementation (C). The decomposer only sees spec-level shape and would be guessing. Both sibling routing decisions (C's full-vs-lite process routing; the model router's model choice) consume C's complexity assessment, not a decomposer estimate.

## Consequences

The decomposer's job shrinks to what it uniquely can do: carve the spec into units and wire dependencies. Clean ownership split across the pipeline — decomposer owns structure, C owns normal implementation planning and complexity, controller owns runtime state and any approved execution profile. Validation (topological sort, cycle detection, referential integrity of `depends_on`) runs on the flat list before the ADR-003 human-approval checkpoint. Probe metadata is independently human-reviewed and validated under ADR-039; the model cannot self-select the cheaper profile.
