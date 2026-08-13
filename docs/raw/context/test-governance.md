# Test Governance

## Purpose

Tests provide bounded, reviewable evidence. A test name, a source scan, a mock, or a passing assertion is not evidence by itself; the exercised boundary must match the claim.

## Lanes

| Lane | Command | Prerequisite | Scope |
|---|---|---|---|
| Root domains | `npm run test:root` | Node 24 | Deterministic domain tests under `test/`. |
| Orchestrator harness | `npm run test:orchestrator` | Node 24 | Control-plane harness tests. |
| Worker harness | `npm run test:worker` | Node 24 | Worker profile/preflight/bootstrap tests. |
| Pool Proof units | `npm run test:pool-proof` | Node 24 | Deterministic Harness and retained-evidence tests. |
| Deterministic aggregate | `npm run test:all` | Node 24 | Every preceding deterministic lane. |
| Docker evidence | `npm run test:docker` | Docker daemon and pinned image | Non-skipping persistent-sandbox lifecycle proof. |
| Retained reports | `npm run proof:reports:verify` | Node 24 | Read-only schema, hash, provenance, and privacy verification. |
| Real model proofs | `npm run proof:stage1` / `npm run proof:stage2` | Approved real model credentials and fixture prerequisites | Explicit acceptance evidence only; never ordinary CI. |

The intentionally red single-worker fixture is not part of any green aggregate. The Harness must prove it fails before a Worker change, then run its named acceptance command after the change.

## Evidence publication

Ordinary tests and read-only verification never rewrite retained proof reports. Generated candidate evidence belongs under a test-owned temporary root. Explicit publication validates the candidate and selector before replacing a permitted retained artifact and updating its manifest hash. Stage 1 and Stage 2 reports remain sealed unless an explicit maintainer action authorizes publication.

Retained evidence contains only contract-approved, bounded facts: command/result status, verifier result, bounded diagnostics, and approved artifact hashes or locators. It never contains prompts, credentials, raw provider errors, host paths, mutable temporary roots, container IDs, or command output.

## Test ownership and cleanup

A test registers cleanup immediately after creating a directory, database, process, socket, container, copied package fixture, or candidate-evidence path. Cleanup may remove only an identifier or path created and owned by that test. Tests never enumerate or sweep a shared temporary-root prefix, a repository workspace, or externally supplied state.

Subprocess environments are constructed explicitly. Tests restore any unavoidable process-global environment mutation exactly, including whether the key existed before the test. Tests mutate copied package fixtures, never tracked schemas or configuration.

## Honest boundary claims

- A red-state test introduces the smallest scoped bad fixture or mutation, runs the real boundary, and asserts rejection plus bounded diagnostic evidence.
- `Promise.all`, timers, or two ordered synchronous calls do not prove concurrency. A concurrency claim requires independent operations gated at an observable overlap point and an asserted fencing/exact-once outcome.
- Static import checks enforce only static dependency policy. Use AST/module analysis rather than source substrings, and pair it with executable behavior evidence for cleanup, isolation, timeout, routing, persistence, or concurrency claims.
- A fake driver proves only the state and protocol it actually simulates. Filesystem persistence, Docker isolation, and Worker termination belong to the dedicated real-runtime evidence lane.
- Tests should be split by production seam and use helpers only for shared fixtures; helper modules never register tests or hide hostile payloads.

## Verification

A changed boundary runs its focused suite, its lane, `npm run typecheck`, and the deterministic aggregate before review. Docker-backed changes additionally run the explicit Docker lane. Any test that claims to protect a security or persistence invariant needs a mutation or hostile-input case that would fail if the mechanism were removed.
