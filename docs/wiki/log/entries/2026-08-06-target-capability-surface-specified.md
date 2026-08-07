# 2026-08-06 — Target-provided capability surface specified

## Context

During the Pool Proof Stage 1 tour, a tension was raised: the Worker disables
ambient discovery of target-repository skills, context files, and extensions
(`--no-skills`, `--no-context-files`, `--no-extensions`). Target maintainers
may legitimately ship skills to help agents work in their codebase, so the
baseline appears to hamstring useful capability.

## Decision

Recorded a three-tier trust policy for repository-provided capability surface
in `docs/raw/specs/pool-proof.md` under "Target instructions":

1. **Context files / skills (instructions)** — the genuinely helpful tier. Not
   discovered at the Stage 1 baseline. Re-enter only as advisory, projected,
   read-only, secret-scanned, provenance-tagged input under explicit
   capability grant — never ambient auto-discovery — and subordinated to the
   authoritative identity capsule.
2. **Extensions / MCP (code)** — never auto-loaded. Re-enter only after
   controller onboarding enforces pinning, read-only allowlists, scoped
   secrets/egress, phase grants, and provenance (ADR-029 external-provider
   track). Repository configuration must never auto-launch code.
3. **Ambient host profile** — never inherited; the Worker world is assembled
   per attempt by the launcher.

## Why

"Skills/extensions/context" had been collapsed in discussion into one block.
They are three distinct trust levels: instructions (prompt-level), code
(process-level RCE), and host inheritance. The Stage 1 baseline disabling all
three is a minimal-trust starting point, not the permanent policy. The identity
capsule is the firewall that lets instructions return later as advisory
capability without becoming a policy-override vector.

## Status

Specified in the spec. Not implemented — re-enablement is deferred capability
that depends on the tracked egress/external-provider and capability-grant work.
