# Agent Pool Orchestrator Harness

Control-plane Pi assets for model checkpoints owned by the deterministic orchestrator. This boundary is separate from the DAG-unaware `packages/worker-harness/`.

The bootstrap decomposition routing policy lives in `config/model-routing.bootstrap.json`. The approved build DAG node `orchestrator-decomposition-harness` will add the explicitly loaded Pi package, decomposer agent/skill, schema contract, preflight, and tests. Until that node passes, this directory is a routing-ownership scaffold and must not be treated as an executable harness.

Decomposition consumes jobs from the separate orchestrator queue, uses breadth-oriented Codebase Knowledge retrieval, emits ADR-018 node fields, and returns output to deterministic validation/persistence/Gate 1. It never loads `craft-pool` or dispatches Pool Workers directly.
