# Agent Pool Worker Harness

Runtime-only Pi package for fresh sessions executing DAG node attempts inside the agent pool.

This package is deliberately outside `.pi/` so Repository Builder sessions do not auto-discover `craft-pool` or runtime `craft-*` agents. The trusted supervisor/worker image loads it explicitly for Pool Worker sessions.

## Contents

- `skills/craft-pool/` — intra-node CRAFTS conductor workflow.
- `agents/` — runtime C/R/A/F/T/S phase agents.
- `contracts/` — execution-context and phase-artifact schemas.
- `config/` — runtime versions, exact model scope, and bootstrap routing.
- `scripts/preflight.mjs` — mandatory fail-closed actor/capability check.

## Pool Proof builder profile

The Pool Proof builder profile sandbox is defined under
`profiles/pool-proof-builder/`. Its Dockerfile, build instructions, and image
reference rules are documented in `profiles/pool-proof-builder/README.md`.
This top-level package builds the full CRAFTS worker image and must not be
repurposed as the Pool Proof sandbox image.

## Launch contract

The trusted launcher:

1. creates `.agent-pool/execution-context.json` outside version control;
2. sets `AGENT_POOL_ACTOR=pool-worker` plus expected node, attempt, repository, and branch environment values;
3. explicitly loads/installs this Pi package and its `config/settings.json` policy;
4. runs `npm run preflight --prefix packages/worker-harness` before any paid model call;
5. starts the fresh node conductor only after preflight succeeds.

This marker separates roles; it does not replace authentication, authorization, or sandbox isolation.
