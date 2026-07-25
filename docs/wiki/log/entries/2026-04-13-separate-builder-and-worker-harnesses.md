# 2026-04-13 — architecture — separate Repository Builder and Pool Worker harnesses

Separated local Pi resources under `.pi/` from runtime-only resources in `packages/worker-harness/`. Added canonical actor vocabulary, a strict supervisor-issued execution-context schema, fail-closed worker preflight, runtime package/config/contracts, discovery-isolation tests, actor/subject documentation metadata, and a writing-oriented handoff explaining the recursive agents-building-agents failure mode.
