# 2026-08-06 — Stage 1 Pool Proof proven

## Milestone

Stage 1 Pool Proof is proven. One real headless Pi Worker
(`moonshot/kimi-k2.7-code`, an approved builder model) executed one ADR-028
direct attempt in a fresh Docker sandbox, and the runner-owned deterministic
verifier accepted the result.

Retained evidence: `packages/pool-proof-harness/reports/stage-1-proof-report.json`
(`fake_adapter=false`; base-red exit 1 `('hello' !== 'world')` → post-commit
green exit 0; exactly one commit advancing the base; all 15 runner-owned
verifier checks passed; `isolation_probes_pass=true`; cleanup complete).

The CRAFTS slice `single-worker-pool-proof-attempt-1` (flow C-R-A-F-T-S)
passed all six phases with no blocking findings: C, R (real proof), A
(`zai/glm-5.2`), T (`zai/glm-5.2`), S (`zai/glm-5.1`). The A/T/S review
models were Kyler-approved one-off substitutions because the pinned
openai-codex models were rate-limited; independence held because the builder
ran moonshot.

## Gotchas captured this slice

Now recorded in the domain `AGENTS.md` files:

- Custom (non-native) providers such as `moonshot` are host-configured in
  `~/.pi/agent/models.json`, not Pi built-ins. A fresh `PI_CODING_AGENT_DIR`
  with `PI_OFFLINE=1` cannot resolve them; `copyProviderModels` must carry the
  selected provider's entry.
- The headless `--print` Pi Worker must spawn with stdin ignored
  (`stdio: ['ignore','pipe','pipe']`); an open stdin pipe blocks indefinitely
  with zero output.
- The fixture `cpSync` filter must match `.git` as a path segment, not a
  substring, or `.gitignore` is dropped and sandbox-owned `.home/` scaffolding
  dirties the tree.

## Spec updates this slice

`docs/raw/specs/pool-proof.md` gained two subsections:

- "Target-provided capability surface (trust tiers)" — context-files/skills
  (instructions) vs extensions/MCP (code) vs ambient host profile, with the
  identity capsule as the firewall between advisory guidance and policy
  override.
- "Sandbox lifecycle (Stage 1 baseline vs. production target)" — per-call
  ephemeral container baseline vs the deferred persistent per-worker sandbox.

## Named follow-ups

- **Persistent per-worker sandbox** (prerequisite for the agent-pool dogfood
  follow-up); the per-call baseline does not scale to real tool-call volume.
  See the sandbox-lifecycle log entry.
- **models.json credential-strip** — `copyProviderModels` may duplicate an
  apiKey alongside `auth.json`; acceptable for Stage 1 (0700 private dir, not
  mounted, removed on cleanup) but a future hardening pass should strip
  credential fields from the models.json copy. Disposition: owned-follow-up.
- **Local craft model fallback** — wire the review-phase fallback arrays and
  implement real fallback consumption so a primary-model outage does not halt
  the local CRAFTS workflow.

## Residual

The controlled fixture proof is not production authorization for arbitrary
repositories (residual warning, spec-explicit deferrals). Stage 2
(`multi-worker-pool-proof`) is the next ready node.
