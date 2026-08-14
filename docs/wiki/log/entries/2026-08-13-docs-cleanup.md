---
title: Docs cleanup — links, ADR index, proposed-ADR pointers
type: operation
tags: [docs, cleanup, ingest]
created: 2026-08-13
updated: 2026-08-13
---

# Docs cleanup — links, ADR index, proposed-ADR pointers

Maintenance ingest pass over `docs/`.

- Fixed one broken wiki link: `2026-08-03-attempt-provenance-store` pointed a `[[…]]` link at a raw file; converted to a plain path reference.
- `orchestrator-spec.md` §14 ADR Index was stale at 034; added accepted 035 and 036 and noted proposed 037/038.
- Added inline pointers at spec §3.4 and §8 to the proposed ADRs that would amend them, so the body stays authoritative for current accepted state while flagging pending changes.
- Refreshed `overview.md` start-here list with the proposed ADR-037/038 and probe-workflow proposal; bumped dates.

No ADR status, runtime behavior, schema, or controller code changed. The wiki link graph is clean (all source pages are indexed; no orphan synthesis pages).
