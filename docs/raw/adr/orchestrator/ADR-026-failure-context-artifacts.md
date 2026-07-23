# ADR-026: Failure Context Survives Compaction; Transcript Index as Escape Hatch

**Status:** Accepted
**Amends:** the CRAFTS context-discipline rule (craft-pool skill); extends ADR-014 (audit trail)

## Context

Adversarial review identified compaction amnesia: the artifact-forward rule compacts *success* well but strips *failure* discovery. A builder that fought a bizarre edge case and failed would pass only a clean structured artifact forward — the retry then confidently repeats the same mistake, because the nuanced discovery was compacted away.

## Decision

Two mechanisms, primary and escape hatch:

1. **Failure-context artifact section (primary).** A failing phase's emitted artifact MUST include: what was attempted, why it failed, and discoveries made (edge cases, surprising behavior, ruled-out dead ends). Retry attempts receive prior attempts' failure artifacts in their task payload — a retry never starts blind. Still structured, still not a transcript; the discovery survives because it is part of the artifact contract.

2. **Transcript index (escape hatch).** Raw transcripts — already retained on disk per the pool spec as write-once debugging aids — are indexed in the SQLite audit trail by node id + attempt (a `transcript_path` column on the attempt record). Humans (or a future failure-diagnosis step) can look one up directly instead of spelunking the volume. Transcripts are never auto-injected into prompts.

## Consequences

Retries inherit hard-won failure knowledge at artifact cost, not transcript cost; the repeat-the-same-mistake failure mode is addressed at the contract level. The transcript index adds one column and no new storage. Boundary preserved: artifacts are what machines consume, transcripts are what humans consult.
