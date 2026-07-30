# Codebase Knowledge — Domain Instructions

## Terms

- **Target repository**: The repository a future attempt operates on; Agent Pool documentation is target knowledge only when Agent Pool is that target.
- **Source manifest**: The canonical, no-follow, controller-generated inventory of permitted target files used by projection, discovery, Graphify-output validation, and provenance.
- **Scratch projection**: An attempt-scoped controller-owned copy of manifest-approved structural files. Graphify never receives the target checkout path.
- **Index revision**: Immutable metadata binding repository identity, full Git head, Graphify version, index schema version, sensitive-path-policy version, and manifest digest.
- **Predicted-touch evidence**: Controller-owned advisory graph evidence frozen with Gate 1. It identifies likely graph units and shared surfaces; it is not DAG topology.

## Owned state

- Target-scoped, bounded, regenerable controller cache records and graph blobs.
- Source manifests, scratch projections, index revisions, breadth results, and provenance.
- Read-only instruction/documentation discovery availability and link-to-source traceability.
- Controller-only predicted-touch evidence.

## Invariants

- Graphify runs only against a controller-owned scratch projection, never the target checkout.
- Cache roots are outside the target, `docs/`, and `.agent-pool/`; cache keys bind target identity, head, Graphify/index/policy versions, and manifest digest.
- Git and Graphify execute fixed argv with credential-free allowlisted environments. Repository MCP/provider configuration is inert and never auto-launched.
- Graph and documentation results retain stable identifiers and manifest-validated source provenance, not model reasoning.
- Documentation discovery is read-only, index-led, bounded, and returns `unavailable` when no target knowledge store exists. It never creates a sink.
- Predicted-touch evidence is controller-only; workers neither author it nor receive DAG topology, scheduling data, or cache paths.
- Grep/LSP remain direct precise lookup tools. No vector store, embeddings, or semantic RAG belong here.

## Public interfaces

- `buildIndex()` / `refreshIndex()` return a validated `IndexRevision` for an identified target head.
- `breadthRetrieval()` returns bounded graph units, dependency edges, provenance, truncation metadata, and its revision.
- `derivePredictedTouch()` returns controller-only Gate 1 advisory evidence.
- `discoverTargetDocumentation()` returns index-led target documentation results or explicit availability status.

## Dependencies

- Provides structural breadth context to the future orchestrator-side decomposer.
- Provides target-repository retrieval contracts to phase agents without replacing direct grep/LSP.
- Supports Verification with source provenance; it does not determine verdicts or modify target source.

## Trust boundaries

- Target paths, Git metadata/configuration, links, symlinks, and Graphify output are untrusted.
- Manifest capture, scratch projection, no-follow reads, source-path validation, and pre/post indexing integrity checks protect the target boundary.
- Graphify/Git are trusted, pinned executables invoked with fixed read-only contracts; their output remains secondary evidence until validated.
- Cache namespace and retention controls isolate one target/revision from another.

## Verification guidance

- Run `npm test` and `npm run typecheck` from the repository root.
- Run `(cd packages/worker-harness && npm test)` for exact Graphify preflight coverage.
- Cover Graphify node-link validation, target-head races, symlink swaps, sensitive-path exclusion, cache integrity/eviction, index-led provenance, and worker topology exclusion.
- Verify target mutation, malformed output, cache corruption, and unavailable prose knowledge fail closed or return explicit availability/truncation results.

## P0 follow-up hardening

The ADR-032 baseline is implemented with scratch projection, sensitive-path exclusion, and process hardening. The following are approved roadmap P0 work, not implemented controls:

- content-level secret scanning/redaction for target-derived artifacts;
- OS-level default-deny egress for Graphify/indexing processes;
- OS read-only mount/sandbox isolation for target workspaces; and
- reproducible worker-image Graphify/runtime smoke attestation.

## Relevant sources

- `docs/raw/adr/orchestrator/ADR-019-shared-codebase-rag-layer.md`
- `docs/raw/adr/orchestrator/ADR-022-codebase-knowledge-three-retrieval-modes.md`
- `docs/raw/adr/orchestrator/ADR-029-agent-tool-surface-and-phase-scoping.md`
- `docs/raw/adr/orchestrator/ADR-032-practical-worker-isolation-baseline.md`
- `docs/raw/plans/v1-roadmap.md`

## Footguns

- Never index the Agent Pool product docs as a different target repository's knowledge.
- Never write Graphify output, cache data, or a knowledge sink into the target checkout or `.agent-pool/`.
- Never treat graph/prose discovery as authority to alter acceptance criteria, semantic dependencies, or scheduling.
- Never silently serve stale, malformed, unbounded, cross-target, or provenance-free data.
