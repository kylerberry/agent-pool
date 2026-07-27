# Codebase Knowledge — Domain Instructions

## Terms

- **Graphify workspace index**: A persistent knowledge graph produced by the Graphify skill from project files.
- **Graph refresh**: The process of updating indexes to reflect current file contents.
- **Wiki/index discovery**: Locating and surfacing project documentation from `docs/wiki/` and related indexes.
- **Retrieval contract**: A stable query interface for decomposition and phase agents to request context.

## Owned state

- Graphify workspace indexes and their refresh timestamps.
- Wiki/index discovery maps and cached retrieval contracts.
- Index freshness metadata and invalidation records.
- Query logs and retrieval-provenance records.

## Invariants

- Indexes are refreshed from the current workspace state before answering freshness-sensitive queries.
- Retrieval contracts return stable IDs and source paths, not raw reasoning.
- Grep/LSP remain direct tools; this domain owns provisioning and freshness, not agent reasoning.
- No domain may read another domain's internal modules or persistence tables directly.

## Public interfaces

- `indexWorkspace(path)` and `refreshGraph()` commands.
- `queryContext(question)` returning retrieval results with source paths.
- Wiki/index discovery endpoints for `docs/wiki/` and canonical sources.
- Events notifying consumers when indexes are stale or refreshed.

## Dependencies

- Supports Work Intake during decomposition.
- Provides context to Agent Execution when provisioned.
- Assists Verification with source retrieval but does not reason about verdicts.

## Trust boundaries

- Indexes are derived from workspace files and do not inject external web content unless explicitly fetched.
- Query results include provenance so consumers can verify sources.
- This domain does not execute code changes or hold execution credentials.
- Graphify skill outputs are treated as secondary evidence, not authoritative policy.

## Verification guidance

- Test that refresh updates indexes and invalidates stale results.
- Verify retrieval contracts include source paths and stable IDs.
- Confirm index operations do not modify source files.

## Relevant sources

- `docs/raw/context/initial-domain-map.md`
- `docs/raw/adr/orchestrator/`
- `docs/wiki/index.md`
- `docs/AGENTS.md`

## Footguns

- Returning stale indexes without refresh makes downstream decisions depend on old code.
- Letting this domain generate code changes confuses knowledge with execution ownership.
- Treating Graphify outputs as primary policy bypasses canonical documentation.
