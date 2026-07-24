# ADR-032: Practical v1 Worker Isolation Baseline

**Status:** Accepted
**Relates to:** ADR-010, ADR-029, ADR-030

## Context

Workers execute repository-controlled code and generated tests. A production worker cannot expose unrelated workspaces, host control sockets, or long-lived provider/GitHub secrets to that code. Full micro-VM isolation and default-deny egress are desirable but not required for the first personal deployment.

## Decision

v1 workers must use:

- one ephemeral workspace/volume per attempt, destroyed after retained artifacts are extracted;
- non-root containers, no privileged mode or host Docker socket, and explicit CPU/memory/time/process limits;
- a pinned worker image and dependency lockfiles;
- secrets supplied only to trusted orchestration/model-call operations, never inherited by repository commands or tests;
- trusted host-side GitHub delivery using least-privilege credentials; untrusted repository commands do not receive GitHub credentials;
- log/artifact secret redaction and bounded retention.

## Consequences

This is the minimum safe boundary for executing unknown repository code. Rootless runtimes, read-only root filesystems, seccomp/capability profiles, default-deny egress, short-lived GitHub App tokens, signatures/SBOMs, and stronger sandbox technologies remain fast-follow hardening.
