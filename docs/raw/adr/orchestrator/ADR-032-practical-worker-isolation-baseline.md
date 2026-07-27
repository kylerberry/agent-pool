# ADR-032: Practical v1 Worker Isolation Baseline

**Status:** Accepted — amended 2026-07-27
**Relates to:** ADR-010, ADR-029, ADR-030

## Context

Workers execute repository-controlled code and generated tests. A production worker cannot expose unrelated workspaces, host control sockets, or long-lived provider/GitHub secrets to that code. Full micro-VM isolation and default-deny egress are desirable but not required for the first personal deployment.

## Decision

v1 workers must use:

- one ephemeral workspace/volume per attempt, destroyed only after required structured artifacts and the ADR-026 transcript-retention result have been durably recorded; transcript retention follows finalize → redact → hash → external persist → verify → transactional index before cleanup;
- non-root containers, no privileged mode or host Docker socket, and explicit CPU/memory/time/process limits;
- a pinned worker image and dependency lockfiles;
- secrets supplied only to trusted orchestration/model-call operations, never inherited by repository commands or tests;
- trusted host-side GitHub delivery using least-privilege credentials; untrusted repository commands do not receive GitHub credentials;
- log/artifact secret redaction and bounded retention;
- cleanup state that distinguishes `ready`, `extracting`, `audit_complete`, and `audit_incomplete`, with extraction failures recorded before cleanup proceeds.

Workspace destruction remains mandatory and bounded. A failed transcript extraction marks the attempt `audit_incomplete` and alerts operations, but must not retain an untrusted workspace indefinitely. Implementations may use a short, bounded quarantine for retry/diagnosis; after that bound they destroy the workspace while preserving the extraction failure record and all successfully persisted structured artifacts.

## Consequences

This is the minimum safe boundary for executing unknown repository code. Workspace cleanup can no longer silently invalidate ADR-026's transcript index: every retained transcript points to a verified durable object, or the attempt visibly records incomplete audit extraction. Rootless runtimes, read-only root filesystems, seccomp/capability profiles, default-deny egress, short-lived GitHub App tokens, signatures/SBOMs, and stronger sandbox technologies remain fast-follow hardening.
