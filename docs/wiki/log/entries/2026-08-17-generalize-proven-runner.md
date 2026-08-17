---
title: Generalize the proven Pool Proof runner (active plan node 1)
type: activity
tags: [pool-proof, harness, run-task, crafts, milestone-1]
created: 2026-08-17
node: generalize-proven-runner
---

# Generalize the proven Pool Proof runner

Completed the first node of the active 4-node replacement milestone plan:
`generalize-proven-runner` (`generalize-proven-runner-attempt-1`, flow C-R-A-F-T-S).

## What changed

- **`packages/pool-proof-harness/src/run-task.ts`** — generalized proven task runner.
  - Strict task manifest validation with zero side effects on rejection.
  - Fresh temp clone, detached checkout of the pinned 40-hex base commit, clean-porcelain check.
  - Composes `createMinimalPoolRuntime` with existing product seams (resource factory,
    Pi launcher, verifier with `expectedParentCommit=base_commit`, persistence).
  - Runner-owned sandbox command helper bound to manifest
    `bounds.verification_timeout_seconds` (60..900); no hardcoded timeout path.
  - Hardened container-runtime resolution: literal `docker`/`podman` validation,
    `shell:false` lookup, `realpathSync` + `lstatSync` regular non-symlink verification.
  - Candidate-output guard rejects any path resolving into
    `packages/pool-proof-harness/reports/` before `mkdirSync`.
  - Emits schema-valid `TaskRunEvidence`.
- **`packages/pool-proof-harness/src/hardened-git.ts`** — harness-owned duplicate of the
  hardened git environment/override set from `src/domains/verification/pool-proof-verifier.ts:79-110`.
- **`packages/pool-proof-harness/src/task-manifest.ts`** — strict validator with bounded,
  distinct failure codes for hostile manifests.
- **`packages/pool-proof-harness/src/task-run-evidence.ts`** — evidence builder and JSON
  schemas.
- **`packages/pool-proof-harness/test/task-manifest.test.ts`** and
  **`test/run-task.test.ts`** — red-first tests covering green path, mutation cases,
  retained-reports tree snapshots, AST call-site enumeration, hostile `.git` config
  neutralization, and container-runtime resolution.
- **`packages/pool-proof-harness/package.json`** — added `proof:task:run` script; kept it
  out of `test` and `test:all`.
- **`packages/pool-proof-harness/AGENTS.md`** and new **`README.md`** — documented scope,
  trust boundaries, verification commands, and real-model lane usage.

## Verification

- `npm test --prefix packages/pool-proof-harness` — 86 pass / 0 fail.
- `npm run typecheck` — 0 errors.
- `npm run test:all` — exit 0.
- `npm run proof:reports:verify --prefix packages/pool-proof-harness` — retained reports
  unchanged.

## Durable learnings

1. **Hardened-git sync binding.** When a harness needs the same untrusted-repo git
   hardening as the product verifier, duplicate the exact override set locally with a
   sync-binding comment and bind drift with an AST call-site test plus a hostile-config
   mutation test. Do not widen product seams just to share the helper.
2. **Guard-before-mkdir for retained-tree containment.** A containment check that runs
   after `mkdirSync` mutates the retained tree even when it rejects. Reject before any
   directory creation and assert zero new entries in the full retained tree, not just
   byte-identical files.
3. **Literal validation before shell lookup.** Any CLI value that reaches `execFileSync`
   with `shell:true` is a command-injection path; parse it against a literal allow-list
   before lookup, disable `shell`, and verify the resolved executable is a regular
   non-symlink file.
4. **Manifest-bound timeout seam.** The runner's sandbox timeout must be sourced from the
   manifest's bounded field, with a binding test through a fake seam, to avoid a
   hardcoded timeout path.

## Residuals carried forward

- Verifier path containment is string-only; in-repo symlinks within allowed paths are not
  resolved (bounded residual, deferred to `general-deterministic-verifier`).
- Manifest review is process-level trust; the runner validates structure only.
- `proof:task:run` is a paid real-model lane requiring explicit `--sandbox-image` and
  approved model.
