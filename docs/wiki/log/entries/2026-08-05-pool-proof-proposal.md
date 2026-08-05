---
title: Proposed Pool Proof specification and lean candidate DAG
type: operation
tags: [pool-proof, proposed, planning, agent-execution]
created: 2026-08-05
updated: 2026-08-05
sources:
  - docs/raw/specs/pool-proof.md
  - docs/raw/plans/pool-proof-build-dag.candidate.json
---

# Proposed Pool Proof specification and lean candidate DAG

Added an unapproved Pool Proof specification and two-node candidate DAG for human review.

The proposal builds a real Minimal Pool Runtime plus a separate deterministic Harness. Stage 1 proves one real headless approved-model Worker against a controlled fixture. Stage 2 proves two ready slots, three jobs, and continued unrelated work after one runner-injected Worker-process failure.

Worker identity is launcher-established rather than prompt-inferred. Pi control credentials remain outside the untrusted repository sandbox; every attempt receives fresh workspace, session, runtime, actor context, and result identity. Runner-owned fixture verification—not Worker prose—determines outcomes.

The current approved DAG and local ledger were not modified. Implementation remains blocked until Kyler approves the exact candidate and source-specification hashes and the candidate is activated through canonical validation and ledger archive-reset.

See [[wiki/sources/2026-08-05_pool-proof-specification|Pool Proof Specification (Proposed)]].
