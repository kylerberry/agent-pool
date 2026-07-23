# ADR-017: Test Suite Storage, Versioning, and Re-Verification at Integration

**Status:** Accepted

## Context

Each node's Conceptualize phase produces a test suite (the tier-1 answer key). Two questions: where does it live, and how is drift reconciled when suites change — either within a node's own retries or across parallel nodes touching the same test file?

## Decision

**Storage:** the test suite is written to the repo where it executes; the node record holds the path plus a content hash. Not stored inline in SQLite — it's real code that must live in the tree to run (tier-1 executes it, builder builds against it, it ships in the PR). The hash gives the audit trail (ADR-014) an immutable record of exactly which suite version graded each attempt, even after the repo file changes.

**Intra-node versioning:** each revision of the suite during a node's own execution records a new content hash; the audit trail keeps the sequence. Tier-1 grades against the current version. No conflict — one node owns its suite during its turn.

**Cross-node contention:** parallel nodes modifying the same test file are governed by the warm pool's existing optimistic-concurrency rule (CI/test suite as merge-time arbiter) — first to integrate wins, second re-derives against the new head. The test suite is just another file under the same merge-admissibility arbiter as source.

**Re-verification at integration:** a node's `passed` is provisional, not final. Before the PR assembles (ADR-015), tier-1 re-runs against the final merged suite. If a sibling's suite change breaks a previously-passed node, it surfaces as a tier-1 failure at integration and returns to `failed`/retry. Branch-integrated green is the real gate; node-local green is necessary but not final.

## Consequences

Stale-green regressions are structurally prevented — a node can't ship against a suite version that a sibling has since changed out from under it. Cost: a node that passed locally may re-fail at integration, adding a retry cycle; acceptable, since the alternative is silently shipping code that no longer passes its own current tests. This is the DAG-level analog of the pool's merge-time arbitration, keeping one consistent trust model across both layers.
