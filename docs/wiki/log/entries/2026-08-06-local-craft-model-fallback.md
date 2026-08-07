# 2026-08-06 — Local craft model fallback (fast-follow)

## Context

The local CRAFTS review phases (A — Assess, T — Tighten, S — Sharpen) are pinned
to openai-codex models in `.pi/settings.json` (`subagents.agentOverrides`) and
`.pi/model-routing.bootstrap.json`. During the Pool Proof Stage 1 slice,
openai-codex hit its usage limit, blocking A/T/S. Kyler approved a one-off
per-call model override to `zai/glm-5.2` (A, T) and `zai/glm-5.1` (S) for that
slice, which preserved the required builder≠evaluator independence (the builder
ran `moonshot/kimi-k2.7-code`).

Investigation showed the routing file already declares empty `fallback: []`
arrays per role, but **nothing consumes them** — the dispatcher fails closed
when the pinned primary is unavailable rather than substituting.

## Fast-follow (tracked)

Make the local craft workflow robust to a primary-model outage without a manual
per-call override:

1. **Populate the fallback arrays** in `.pi/model-routing.bootstrap.json` for
   the review roles (assessing, tightening, sharpening) with approved
   alternatives (e.g. `zai/glm-5.2`, `moonshot/kimi-k3`), keeping the
   builder≠evaluator independence rule.
2. **Implement real fallback consumption** in the goal-dispatcher / craft spawn
   path so an unavailable primary automatically falls through to the configured
   fallback instead of failing closed.
3. Keep the current fail-closed behavior as the terminal case when no fallback
   is available.

## Why

A single-provider outage should not halt the entire local CRAFTS workflow. The
declarative `fallback` arrays imply this was always intended; wiring them up
removes the need for ad-hoc per-slice model overrides and Kyler escalations.

## Status

Tracked fast-follow. Not implemented. Distinct from the separate request to add
`zai/glm-5.2` and `zai/glm-5.1` to the approved **pool** model registry (that
gates Pool Workers, not the local craft review).
