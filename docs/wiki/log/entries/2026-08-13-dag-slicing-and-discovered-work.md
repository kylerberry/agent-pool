# 2026-08-13 — DAG slicing and discovered work

Recorded two critical future orchestration units.

- **ADR-035** defines each DAG node as the smallest independently verifiable vertical slice: one outcome/oracle, bounded seam, explicit non-goals, and Gate-1 rationale for inseparable cross-domain or multi-contract work. It preserves ADR-018’s five-field emitted-node schema.
- **ADR-036** adds bounded append-only Worker discovery records and controller classification. Discoveries cannot broaden an active attempt or mutate the DAG. Adjacent items become backlog candidates; blockers use governed resolution; topology/scope changes use human-approved ADR-024 amendment with renewed Gate 1 and preserved passed work.
