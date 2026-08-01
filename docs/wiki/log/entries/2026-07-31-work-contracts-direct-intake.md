---
title: Work Contracts and Direct Intake
type: output
tags: [work-intake, contracts, idempotency, security]
created: 2026-07-31
updated: 2026-07-31
sources:
  - docs/raw/adr/orchestrator/ADR-018-decomposition-emission-schema.md
  - docs/raw/adr/orchestrator/ADR-027-spec-intake-api.md
  - docs/raw/adr/orchestrator/ADR-028-direct-task-path.md
  - docs/raw/adr/orchestrator/ADR-031-practical-delivery-idempotency.md
  - docs/raw/specs/orchestrator-spec.md
---

# Work Contracts and Direct Intake

Implemented immutable Work Intake contracts and the `POST /tasks` direct-task path. One direct unit and a hand-authored flat DAG enter through a single application boundary and normalize to the same accepted shape, differing only in a recorded `submission_shape`.

Mechanical validation is deterministic and collects every violation rather than short-circuiting: duplicate ids, unknown or self dependencies, cycles (Kahn's algorithm), unknown fields, and absent acceptance criteria. Violations are sorted into a stable order, so identical payloads yield byte-identical rejections. Per ADR-018, controller-owned runtime state and C-owned `complexity` are rejected as unknown fields rather than silently dropped.

Acceptance criteria are carried across unchanged — copied, never normalized — and deep-frozen with `origin=direct_task` plus caller, submission, and unit identifiers, so the CRAFTS C phase can treat them as ground truth.

Idempotency is scoped to `(caller_id, route, key)` with length-prefixed components, hashed over the normalized submission. The caller id comes from the authenticated principal and never from the request body. Rejected payloads do not burn the key.

Gate 1 is skipped because there is no decomposition to quarantine (ADR-028); `gate2_required` is a structural `true` with no caller-reachable override. The boundary is synchronous by signature, so it cannot await a model call — the no-decomposition property is enforced by type, not convention.

Persistence, dispatch, and Gate 2 grading are deliberately absent: the idempotency store is a narrow injected seam awaiting the controller's SQLite implementation.

Related: [[wiki/architecture/supervisor-orchestrator|Supervisor Orchestrator]].
