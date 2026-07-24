# CRAFTS Phase Artifact Contract

**Version:** 1
**Status:** Required for v1

Every CRAFTS phase returns one JSON artifact validated against `docs/raw/specs/schemas/crafts-phase-artifact.schema.json` (JSON Schema 2020-12). Prose-only phase completion is invalid. The node's fresh Pi session owns the original task and acceptance criteria, launches phase subagents sequentially with `pi-subagents`, validates each artifact, persists it to the audit trail, and passes only the validated artifact—not the phase transcript—to the next phase. Pi launches use the matching schema as `outputSchema` so `structured_output` is available to the child.

## Common envelope

Every artifact contains:

- `schema_version`: `1`
- `node_id`, `attempt_id`, `phase`
- `status`: `passed | needs_fix | failed | blocked`
- `model`: provider-qualified Pi model ID
- `started_at`, `completed_at`
- `summary`
- `acceptance_criteria_status`: one entry per original criterion with `criterion`, `status`, and `evidence`
- `changed_files`: empty for read-only phases
- `commands_run`: command, exit code, and concise output reference
- `cost`: input/output tokens and provider-reported cost when available
- `risks`, `open_questions`, `recommended_next_step`
- `failure_context`: required unless `status` is `passed`; includes `attempted`, `failure_reason`, `discoveries`, and `dead_ends`
- `transcript_path`: audit reference only; transcripts are never forwarded as phase context

The controller rejects missing criteria, unknown criteria, unqualified model IDs, invalid status transitions, write reports from read-only phases, or output that fails schema validation.

Phase-specific fields live under `phase_data`; fields outside the schema are rejected.

## Phase payloads

### C — Conceptualize

Adds `complexity`, `selected_flow`, `scope`, `non_goals`, `test_strategy`, `planned_files`, `trust_boundaries`, and `render_plan`. C may not author or alter acceptance criteria.

### R — Render

Adds `red_evidence` and `green_evidence`, each tied to pre/post commit SHA, suite path/hash, command, exit code, environment/image digest, and raw-output artifact path. Adds `implementation_notes` and `patch_path`.

### A — Assess

Adds `criteria_fit`, `maintainability`, `blocking_findings`, and `non_blocking_observations`. It must audit both the suite and implementation against every original criterion. A is read-only.

### F — Fix

Adds `findings_addressed`, `documented_disagreements`, refreshed `green_evidence`, and `patch_path`.

### T — Tighten

Adds `trust_boundaries_reviewed`, `security_findings`, `security_commands`, and `residual_risk`. T is read-only; fixes return to F.

### S — Sharpen

Adds `docs_changed`, `domain_instructions_changed`, `wiki_pages_changed`, and `durable_learnings`. S may write only documentation and instruction files.

## Tier-2 bootstrap gate

Before empirical task-class thresholds exist:

- `criteria_fit` is a binary hard gate: every original criterion must have direct evidence and no blocking mismatch; unknown or incomplete evidence fails closed.
- `maintainability` records scores from 0–4 for correctness risk, locality/simplicity, interface clarity, type/error safety, and test quality. Each dimension uses the same anchors: `0` = critical defect or absent evidence; `1` = major defect requiring redesign; `2` = acceptable with bounded non-blocking weakness; `3` = strong with no material weakness; `4` = exemplary and directly evidenced. Every score requires rationale.
- Bootstrap passage requires no blocking maintainability finding; numeric maintainability scores are recorded for calibration but do not create an arbitrary threshold.

Once sufficient eval data exists, ADR-009's empirical per-task-class threshold replaces bootstrap mode. The criteria-fit hard gate remains.
