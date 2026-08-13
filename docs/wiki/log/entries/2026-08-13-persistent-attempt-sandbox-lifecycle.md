# 2026-08-13 — Persistent attempt sandbox lifecycle proven

## Milestone

The persistent per-attempt sandbox lifecycle is implemented and proven. Each accepted attempt now gets one fresh long-lived repository container, created at `SandboxBroker.start()` and reused across every `runTool` call in that attempt; a new attempt always gets a fresh container, workspace, HOME/XDG tree, and ownership binding. The launcher tears the owned container down on every terminal path (Worker success/failure, injected termination, timeout, Pi spawn error, broker failure or premature disconnect, attempt release, orderly shutdown).

Retained evidence: `packages/pool-proof-harness/reports/persistent-attempt-sandbox-lifecycle-report.json` (real-Docker lifecycle proof, 19 verdicts all true, 0 final owned containers). Stage 1 (`46dcce…`) and Stage 2 (`ebf984…`) retained report hashes are unchanged.

## What changed

- One persistent `RepositorySandbox` container per broker/attempt replaces the proof-only per-tool-call `docker run --rm`. `SandboxBroker` owns the container; `RepositorySandbox` exposes only `start`/`runTool`/`stop` — no caller-visible container ID, PID, generic kill, or arbitrary targeting.
- Direct runtime argv hardening: pinned sha256 image, non-root UID, `network none`, `--init`, `cap-drop ALL`, `no-new-privileges`, read-only root, CPU/memory/PID limits, one workspace mount. Container identity is captured internally from a private cidfile and validated.
- Launcher cleanup never rejects (it is awaited inside async child `exit`/`error` callbacks); broker/container removal failures are captured internally so `launch` always settles deterministically, while the bounded removal error is still surfaced to the direct `RepositorySandbox.stop` caller.
- `SandboxBroker.terminalFailure` channel propagates post-listen server failure to the launcher for owned teardown. Concurrent `stop` callers share one memoized completion.
- Output is bounded by UTF-8 bytes (raw `Buffer` accounting with fatal-decode backoff), not character slicing. A pre-aborted signal registers the command before any cancel frame.
- A test-only `createMinimalPoolRuntimeForTest` admits explicit fake provenance and rejects all-real provenance; production `createMinimalPoolRuntime` still rejects any fake provenance.

## Durable guidance

- A lifecycle test that drives `RepositorySandbox` directly proves `stop` removes the owned container — it does not prove Worker-kill cleanup. Real Worker-termination→container teardown is proven at the launcher layer (`INJECTED_WORKER_FAILURE`).
- macOS `AF_UNIX` paths cap near 104 bytes; per-attempt broker sockets must live under a short, owner-only temp root.
- Production startup must never accept a fake image/driver; labeled `_testOnly*` seams are test-only.

## Residual risk

Host crash, container-daemon restart, and launcher-SIGKILL reconciliation remain explicitly out of scope for this slice; a container could survive those. Pi is pinned to host `0.84.1` across the preflight gate, identity sentinel, and fixtures; Stage 1/2 retained reports stay sealed at their generation-time versions.

## Next prerequisite

Pool Proof remains fixture-only, not authorization for arbitrary repositories. The next approved work is Z.ai Pool Worker qualification, then the separately reviewed `agent-pool` dogfood task.
