# Local Eval Telemetry Extension

Project-local Pi extension for collecting eval-candidate telemetry while Repository Builders execute approved `/goal` nodes.

## Activation

Pi auto-discovers `index.ts`. Run `/reload` after installing or changing the extension. Only `pi-subagents` child sessions whose agent name starts with `local-craft-` and whose identity matches the active goal ledger/workspace guard are associated with a build phase.

## Storage

```text
.pi/goal-runs/<run-id>/
  telemetry/sessions/<session-key>/
    events.jsonl
    manifest.json
  eval-candidates/<node-id>/<attempt-id>.json
```

The whole run directory is ignored by Git.

## Privacy boundary

Stored: provider/model, numeric usage/cost, role/phase, per-run keyed prompt/system hashes and coarse length buckets, active tool names, opaque tool-call IDs, durations/outcomes, version pins, session hashes, Git SHA/dirty boolean, and relative artifact references.

Not stored: prompt/system text, exact prompt lengths, assistant text, reasoning, tool arguments/results, environment variables, credentials, changed-file names, or absolute external session paths. The per-run HMAC key remains in the ignored private run directory and is never exported to candidates.

## Filesystem trust assumption

Telemetry directories are owner-only, final files use no-follow opens, and all ledger/session/artifact paths are containment-checked with symlink rejection. As a same-user Pi extension, this is not an OS security boundary: a malicious concurrent process running under the same UID could still race path replacement between userspace checks. The local dispatcher prevents concurrent writers in one worktree; stronger protection requires a sandbox or separate OS identity.

## Status

Use `/eval-telemetry-status`. Missing or failed telemetry reports a degraded/unassociated status but never blocks model work or rolls back node completion.

## Eval semantics

Completion records are `telemetry-only`. They do not alter model routing. Promotion requires an independently reviewed reproducible fixture with pre-existing tests, followed by bare-builder runs with production-equivalent tools and N=3 repetitions per task/model.
