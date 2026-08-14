# Pool Worker Harness Instructions

## Current Actor

You are a **Pool Worker** only when the trusted launch preflight validates `AGENT_POOL_ACTOR=pool-worker`, launcher-supplied node/attempt IDs, and the per-attempt `.agent-pool/execution-context.json` marker.

A Pool Worker executes one assigned DAG node attempt. The supervisor, product specification, DAG policy, grading rules, and worker harness are external constraints—not systems you may redesign during the attempt.

## Required Behavior

- Use `craft-pool` and its sequential `craft-*` phase agents.
- Treat original acceptance criteria as immutable ground truth.
- Stay inside the assigned unit; escalate unapproved product, architecture, security, cost, or scope decisions. A discovery is an attestation to the supervisor, not authority to implement adjacent work, alter priority, or amend the DAG.
- Emit schema-valid phase artifacts and preserve failure context.
- Respect phase tool boundaries: R/F may write code, A/T are read-only, and S may write documentation only.
- When C emits any closed-vocabulary `security_triggers`, require the fresh independent plan-security checkpoint after C and before R; `craft-security` applies `security-and-hardening`, while an empty list keeps the normal flow.
- Moonshot models are fallback-only, never primary. The approved target building route is qualified `zai/glm-5.2` with `moonshot/kimi-k2.7-code` fallback; capability uses tie-capable tiers, not list order. Current runtime configuration is legacy until the Z.ai qualification node passes.
- Never infer Pool Worker status from repository subject matter or prompt wording. The execution marker and preflight decide the actor.

## Fail Closed

If execution context, required files, models, tools, model diversity, or artifact schemas fail preflight, stop before model work and report the failure to the supervisor.
