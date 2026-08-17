# Pool Proof Harness

A proof-only harness for the Agent Pool minimal runtime. It demonstrates that one
approved task can run through `createMinimalPoolRuntime()` with deterministic
verification, bounded output, and runner-owned evidence.

## What lives here

- `src/run-stage-1.ts`, `src/run-stage-2.ts` — fixture-based Stage 1 / Stage 2 proof runners.
- `src/run-task.ts` — generalized proven task runner driven by a reviewed task manifest.
- `src/hardened-git.ts` — harness-owned duplicate of the product verifier's hardened git
  environment, used for clone/checkout of untrusted target repositories.
- `src/task-manifest.ts`, `src/task-run-evidence.ts` — strict manifest validator and
  evidence builder/schemas.
- `src/preflight.ts` — host/environment checks before any real-model run.
- `test/` — red-first unit and integration tests, including mutation cases for path
  containment, hardened-git call-site enumeration, and container-runtime resolution.

## Running tests

```bash
npm test --prefix packages/pool-proof-harness
npm run typecheck
npm run test:all
npm run proof:reports:verify --prefix packages/pool-proof-harness
```

## Running a real-model task

`proof:task:run` is a paid, real-model lane and is deliberately excluded from the test
aggregates. Run it only after preflight passes and with an approved model + sandbox image:

```bash
npm run proof:task:run -- \
  --manifest ./path/to/manifest.json \
  --sandbox-image sha256:<digest> \
  [--container-runtime docker|podman]
```

## Key invariants

- Manifest validation is side-effect-free; malformed manifests fail before any git clone,
  store, adapter, or sandbox work.
- Every git invocation in `run-task.ts` routes through `hardened-git.ts`.
- The runner starts from the pinned 40-hex base commit, uses a fresh isolated Worker and
  sandbox, and produces at most one commit touching only the manifest's allowed paths.
- Runner-owned evidence is written only after successful schema validation and never into
  `packages/pool-proof-harness/reports/`.
- Container runtime is resolved with `shell:false` and verified as a regular non-symlink
  executable before the sandbox is launched.
