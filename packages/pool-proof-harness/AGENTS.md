---
audience: repository-builder
subject: development-harness
---

# Pool Proof Harness — Package Instructions

## Current Actor

You are a **Repository Builder** invoking this proof-only harness. This package does not confer Pool Worker authority.

## Purpose

Proof-only harness that drives the public Minimal Pool Runtime through a deterministic fixture repository and produces a bounded Stage 1 proof report.

## Scope

- Own one deterministic fixture repository.
- Define ADR-028-shaped atomic fixture jobs and allowed-path manifests.
- Invoke `createMinimalPoolRuntime()` from `src/domains/agent-execution/minimal-pool-runtime.ts`.
- Run an independent runner-owned verifier over the result.
- Emit a schema-valid Stage 1 proof report only after a real-model verifier pass.

## Non-Goals

- Do not simulate the queue, slot, Worker launcher, Pi process, repository sandbox, commit, or result path during acceptance runs.
- Do not import control-plane policy from `packages/orchestrator-harness`.
- Do not weaken the full CRAFTS profile or `packages/worker-harness/scripts/preflight.mjs`.

## Trust Boundaries

- The Harness is a product caller, not a Pool Worker.
- Acceptance entry point rejects injected fake process, sandbox, clock, or verifier adapters.
- Fake adapters are allowed only in automated tests and must be labeled in evidence.

## Verification

- Run `npm test --prefix packages/pool-proof-harness`.
- Run real proof only after `npm run proof:stage1:preflight` passes with pinned Pi, approved builder model, and container runtime.

## Footguns

- The fixture `cpSync` filter must match `.git` as a **path segment** (`/(?:^|\/)\.git(?:\/|$)/`), not a substring. A substring match also excludes `.gitignore`, dropping the fixture's ignore rules and letting sandbox-owned `.home/` scaffolding dirty the copied tree (fails `clean_tree`).

## Relevant sources

- `docs/raw/specs/pool-proof.md`
- `src/domains/agent-execution/AGENTS.md`
