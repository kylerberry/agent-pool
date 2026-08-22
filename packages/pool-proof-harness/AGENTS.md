---
audience: repository-builder
subject: development-harness
---

# Pool Proof Harness — Package Instructions

## Current Actor

You are a **Repository Builder** invoking this proof-only harness. This package does not confer Pool Worker authority.

## Purpose

Proof-only harness that drives the public Minimal Pool Runtime through either a deterministic fixture repository or a reviewed task manifest, producing bounded Stage 1 / task-run evidence.

## Scope

- Own deterministic fixture repositories and the generalized `run-task.ts` entry point.
- Re-export the production `TaskManifest` validator from `src/composition/task-manifest.ts`. Production code must not import this package.
- Define ADR-028-shaped atomic fixture jobs and allowed-path manifests.
- Invoke `createMinimalPoolRuntime()` from `src/domains/agent-execution/minimal-pool-runtime.ts`.
- Run an independent runner-owned verifier over the result.
- Emit schema-valid Stage 1 / task-run evidence only after a verifier pass.
- Provide a harness-owned `hardened-git.ts` helper that duplicates the exact override set used by the product verifier so untrusted repository content cannot reach host-side git during clone/checkout.

## Non-Goals

- Do not simulate the queue, slot, Worker launcher, Pi process, repository sandbox, commit, or result path during acceptance runs.
- Do not import control-plane policy from `packages/orchestrator-harness`.
- Do not weaken the full CRAFTS profile or `packages/worker-harness/scripts/preflight.mjs`.
- Do not edit `src/domains/` seams; duplicate security-critical helpers locally rather than exporting product internals.

## Trust Boundaries

- The Harness is a product caller, not a Pool Worker.
- Acceptance entry point rejects injected fake process, sandbox, clock, or verifier adapters.
- Fake adapters are allowed only in automated tests and must be labeled in evidence.
- The generalized runner validates the task manifest before any side effect, pins the base commit, checks out a fresh temp clone through `hardened-git.ts`, and rejects any candidate output path that resolves into `packages/pool-proof-harness/reports/` before `mkdirSync`.
- Container runtime resolution is literal-only (`docker`/`podman`), resolved with `shell:false`, and verified as a regular non-symlink file before any sandbox launch.

## Verification

- Run `npm test --prefix packages/pool-proof-harness`.
- Run real proof only after `npm run proof:stage1:preflight` passes with pinned Pi, approved builder model, and container runtime.
- For a real-model task run, use `npm run proof:task:run -- --manifest <path> --sandbox-image <sha256>` explicitly; this lane is excluded from `npm test` and `test:all`.

## Footguns

- The fixture `cpSync` filter must match `.git` as a **path segment** (`/(?:^|\/)\.git(?:\/|$)/`), not a substring. A substring match also excludes `.gitignore`, dropping the fixture's ignore rules and letting sandbox-owned `.home/` scaffolding dirty the copied tree (fails `clean_tree`).

## Relevant sources

- `docs/raw/specs/pool-proof.md`
- `src/domains/agent-execution/AGENTS.md`
