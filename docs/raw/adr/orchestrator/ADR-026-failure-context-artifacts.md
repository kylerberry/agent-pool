# ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch

**Status:** Accepted — amended 2026-07-27
**Amends:** the CRAFTS context-discipline rule (craft-pool skill); extends ADR-014 (audit trail)
**Related:** ADR-032 (ephemeral worker isolation)

## Context

Adversarial review identified compaction amnesia: the artifact-forward rule compacts *success* well but strips *failure* discovery. A builder that fought a bizarre edge case and failed would pass only a clean structured artifact forward — the retry then confidently repeats the same mistake, because the nuanced discovery was compacted away.

## Decision

Two mechanisms, primary and escape hatch:

1. **Failure-context artifact section (primary).** A failing phase's emitted artifact MUST include: what was attempted, why it failed, and discoveries made (edge cases, surprising behavior, ruled-out dead ends). Retry attempts receive prior attempts' failure artifacts in their task payload — a retry never starts blind. Still structured, still not a transcript; the discovery survives because it is part of the artifact contract.

2. **Durable transcript object + index (escape hatch).** A transcript that is retained must be finalized, secret-redacted, hashed, and copied from the ephemeral attempt workspace into bounded-retention object storage before workspace cleanup. Only after the durable object is verified does the orchestrator transactionally index it in SQLite by node + attempt + phase/session. Transcripts are never auto-injected into prompts.

The audit record stores a durable object id/locator rather than an attempt-workspace path, plus SHA-256, byte size, media/schema version, redaction policy version and status, creation time, retention/deletion status, access classification, and extraction status. The existing `transcript_path` name is deprecated: implementations may read it for migration, but new records use `transcript_object_id` and must not contain absolute ephemeral workspace paths.

Finalization ordering is explicit:

1. finalize and close the transcript;
2. redact and hash it;
3. persist it outside the attempt workspace;
4. verify the stored object's hash and metadata;
5. commit the audit index record;
6. mark transcript extraction complete;
7. permit workspace destruction under ADR-032.

If any extraction step fails, the attempt is marked `audit_incomplete` with a structured failure reason and operational alert. The structured failure-context artifact remains the primary machine-consumed record, so transcript extraction failure does not by itself invalidate otherwise-correct code or authorize indefinite retention of an unsafe workspace.

## Consequences

Retries inherit hard-won failure knowledge at artifact cost, not transcript cost; the repeat-the-same-mistake failure mode is addressed at the contract level. Transcript retention now requires an explicit durable-object lifecycle, access controls, bounded retention, and audit-completeness state rather than a potentially dangling filesystem pointer. Boundary preserved: artifacts are what machines consume, transcripts are what authorized humans consult.
