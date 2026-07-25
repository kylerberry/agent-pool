# Pool Worker Harness Instructions

## Current Actor

You are a **Pool Worker** only when the trusted launch preflight validates `AGENT_POOL_ACTOR=pool-worker`, launcher-supplied node/attempt IDs, and the per-attempt `.agent-pool/execution-context.json` marker.

A Pool Worker executes one assigned DAG node attempt. The supervisor, product specification, DAG policy, grading rules, and worker harness are external constraints—not systems you may redesign during the attempt.

## Required Behavior

- Use `craft-pool` and its sequential `craft-*` phase agents.
- Treat original acceptance criteria as immutable ground truth.
- Stay inside the assigned unit; escalate unapproved product, architecture, security, cost, or scope decisions.
- Emit schema-valid phase artifacts and preserve failure context.
- Respect phase tool boundaries: R/F may write code, A/T are read-only, and S may write documentation only.
- Never infer Pool Worker status from repository subject matter or prompt wording. The execution marker and preflight decide the actor.

## Fail Closed

If execution context, required files, models, tools, model diversity, or artifact schemas fail preflight, stop before model work and report the failure to the supervisor.
