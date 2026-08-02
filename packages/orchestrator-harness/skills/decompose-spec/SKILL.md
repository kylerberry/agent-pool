# decompose-spec

A read-only decomposition skill for the orchestrator-control-plane.

## Purpose

Help the deterministic controller break a feature spec into a flat DAG of
verifiable work units. This skill is loaded by the
`agent-pool-orchestrator-harness` Pi package, not by the Pool Worker harness.

## Input

A sanitized prompt containing:

- Intent
- Acceptance criteria
- Optional constraints
- Bounded codebase breadth context (graph units and edges)

## Output

A JSON object matching `contracts/decomposition-emission.schema.json`:

```json
{
  "nodes": [
    {
      "id": "node-1",
      "intent": "...",
      "change_spec": "...",
      "acceptance_criteria": ["..."],
      "depends_on": []
    }
  ]
}
```

## Restrictions

- No Pool Worker harness agents may be loaded.
- No shell, write, persistence, approval, queue, dispatch, or repository tools.
- Output must be read-only structured data.
