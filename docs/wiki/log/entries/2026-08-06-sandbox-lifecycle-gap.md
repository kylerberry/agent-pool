# 2026-08-06 — Sandbox lifecycle gap recorded (per-call vs persistent-per-worker)

## Context

During the Pool Proof Stage 1 tour, the sandbox topology was clarified: Stage 1
spawns a fresh `docker run --rm` container **per repository tool call**. An
attempt can issue hundreds of tool calls, so per-call container start cost
dominates wall time and does not scale to real workloads.

Separately, the deployment tenet was reconfirmed against the docs: cheap
self-hosted VM (~$10/month, Docker Compose, "one container per agent" per the
old spec). render.com was considered and rejected — it is not a documented
tenet (the "Render" mentions in docs are the CRAFTS R phase), and PaaS hosting
generally disallows the nested/privileged containers the sandbox model needs.

## Decision

Recorded the sandbox lifecycle gap in `docs/raw/specs/pool-proof.md` under the
untrusted-repository-zone section:

- **Stage 1 baseline:** one fresh, destroyed-after container per tool call —
  maximally isolated and stateless, chosen for proof correctness, not
  performance.
- **Production target:** a persistent per-worker sandbox container that lives
  for one attempt, with tool calls piped through an in-container supervisor
  instead of a fresh `docker run` per call.
- **Hard requirement the move re-introduces:** per-command credential isolation
  inside a long-lived container (allowlist env, workspace-scoped `HOME`, no
  provider-credential visibility — ADR-032). The per-call baseline gets this for
  free; the persistent container must re-earn it via its supervisor.
- The `runTool` broker interface is abstract enough that this is an
  implementation change behind the same boundary, not a redesign.

## Why

Per-call ephemeral containers are a proof-time simplification, not the
production shape. The original spec already specified "one container per agent"
(Docker Compose); the latency concern points back to that. The lifecycle
upgrade is deferred from Pool Proof and is the prerequisite for the agent-pool
dogfood follow-up, where real tool-call volume first appears.

## Status

Specified as a deferred-scope gap. Not implemented. Deployment tenet requires
no change (documented VM/Docker-Compose model already matches).
