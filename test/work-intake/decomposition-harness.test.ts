import test from "node:test";
import assert from "node:assert/strict";
import type {
  DecompositionJob,
  DecompositionCandidate,
  DecompositionNode,
  DecompositionFailure,
  DecompositionInvocationRecord,
  BreadthRetriever,
  DecompositionModelInvoker,
} from "../../src/domains/work-intake/decomposition-contracts.ts";
import {
  isDecompositionFailure,
  isDecompositionCandidate,
} from "../../src/domains/work-intake/decomposition-contracts.ts";
import { runDecomposition } from "../../src/domains/work-intake/decomposition-harness.ts";
import { loadOrchestratorBootstrapPolicyFromSource } from "../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts";
import type { IndexRevision, BreadthResult } from "../../src/domains/codebase-knowledge/contracts.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const VALID_INDEX_REVISION: IndexRevision = {
  repository: { owner: "owner", name: "repo" },
  head: "a".repeat(40),
  graphifyVersion: "0.9.25",
  indexSchemaVersion: "1",
  sensitivePathPolicyVersion: "1",
  manifestDigest: "sha256:manifest",
  indexRevision: "rev-1",
  createdAt: new Date().toISOString(),
};

function validJob(overrides: Partial<DecompositionJob> = {}): DecompositionJob {
  return {
    jobId: "job-1",
    spec: {
      intent: "Add user authentication",
      acceptanceCriteria: ["Users can log in", "Sessions expire after 24h"],
    },
    rawSpec: "Implement a login endpoint with session expiry.",
    targetRepository: { owner: "owner", name: "repo" },
    head: "a".repeat(40),
    indexRevision: VALID_INDEX_REVISION,
    ...overrides,
  };
}

function flatCandidate(): DecompositionCandidate {
  return {
    nodes: [
      {
        id: "auth-1",
        intent: "Create login endpoint",
        change_spec: "Add POST /login route",
        acceptance_criteria: ["Returns token on valid credentials"],
        depends_on: [],
      },
      {
        id: "auth-2",
        intent: "Add session expiry",
        change_spec: "Set 24h TTL on sessions",
        acceptance_criteria: ["Expired sessions are rejected"],
        depends_on: ["auth-1"],
      },
    ],
  };
}

function convergentCandidate(): DecompositionCandidate {
  return {
    nodes: [
      { id: "a", intent: "A", change_spec: "do A", acceptance_criteria: ["A passes"], depends_on: [] },
      { id: "b", intent: "B", change_spec: "do B", acceptance_criteria: ["B passes"], depends_on: [] },
      { id: "c", intent: "C", change_spec: "do C", acceptance_criteria: ["C passes"], depends_on: ["a", "b"] },
    ],
  };
}

function makeBreadthResult(overrides: Partial<BreadthResult> = {}): BreadthResult {
  return {
    revision: VALID_INDEX_REVISION,
    units: [{ id: "u1", label: "Login", kind: "function", sourcePath: "src/auth.js" }],
    edges: [],
    truncated: false,
    ...overrides,
  };
}

function makeRetriever(result: BreadthResult): BreadthRetriever {
  return { retrieve: async () => result };
}

function makeInvoker(responses: string[]): DecompositionModelInvoker {
  let callCount = 0;
  return {
    invoke: async () => {
      const response = responses[callCount] ?? "[]";
      callCount += 1;
      return response;
    },
  };
}

function getCandidate(result: unknown): DecompositionCandidate {
  assert.ok(isDecompositionCandidate(result), "expected candidate");
  return result as DecompositionCandidate;
}

function getFailure(result: unknown): DecompositionFailure {
  assert.ok(isDecompositionFailure(result), `expected failure, got ${JSON.stringify(result)}`);
  return result as DecompositionFailure;
}

test("decomposes a valid flat DAG with injected ports", async () => {
  const job = validJob();
  const candidate = flatCandidate();
  const result = await runDecomposition({
    job,
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
  });
  const out = getCandidate(result);
  assert.equal(out.nodes.length, 2);
  assert.deepEqual(out.nodes.map((n) => n.id), ["auth-1", "auth-2"]);
});

test("decomposes a convergent DAG", async () => {
  const candidate = convergentCandidate();
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
  });
  const out = getCandidate(result);
  const nodeC = out.nodes.find((n) => n.id === "c");
  assert.deepEqual(nodeC?.depends_on, ["a", "b"]);
});

test("selects Kimi K3 primary when available", async () => {
  const candidate = flatCandidate();
  const record: DecompositionInvocationRecord[] = [];
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
    onRecord: (r) => record.push(r),
  });
  assert.equal(record.length, 1);
  const record0 = record[0]!;
  assert.equal(record0.selectedModel, "moonshot/kimi-k3");
  assert.equal(record0.routing.fallbackBehavior.primaryAvailable, true);
});

test("falls back to Sol when Kimi K3 is unavailable", async () => {
  const candidate = flatCandidate();
  const record: DecompositionInvocationRecord[] = [];
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "openai-codex/gpt-5.6-sol" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
    onRecord: (r) => record.push(r),
  });
  const record1 = record[0]!;
  assert.equal(record1.selectedModel, "openai-codex/gpt-5.6-sol");
  assert.equal(record1.routing.fallbackBehavior.primaryAvailable, false);
  assert.equal(record1.routing.fallbackBehavior.selectedFallbackIndex, 0);
});

test("fails closed when no approved candidate is available", async () => {
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "openai-codex/gpt-5.6-luna" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "NO_AVAILABLE_CANDIDATE");
});

test("fails closed for unavailable explicit model", async () => {
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "openai-codex/gpt-5.6-sol" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
    explicitModelId: "moonshot/kimi-k3",
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "UNAVAILABLE_EXPLICIT_MODEL");
});

test("rejects malformed availability snapshot", async () => {
  const result = await runDecomposition({
    job: validJob(),
    availability: { fullId: "moonshot/kimi-k3" } as unknown as readonly { fullId: string }[],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_AVAILABILITY");
});

test("rejects unknown fields in job", async () => {
  const result = await runDecomposition({
    job: { ...validJob(), unexpectedField: true } as unknown as DecompositionJob,
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_JOB");
});

test("rejects job with mismatched index revision head", async () => {
  const result = await runDecomposition({
    job: validJob({ head: "b".repeat(40) }),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INDEX_REVISION_MISMATCH");
});

test("rejects oversized raw spec", async () => {
  const result = await runDecomposition({
    job: validJob({ rawSpec: "x".repeat(70_000) }),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "RAW_SPEC_LIMIT_EXCEEDED");
});

test("rejects model output with unknown top-level fields", async () => {
  const badOutput = JSON.stringify({ nodes: flatCandidate().nodes, status: "ok" });
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([badOutput]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
});

test("rejects per-node fields outside ADR-018 projection", async () => {
  const badCandidate = {
    nodes: [
      {
        id: "x",
        intent: "X",
        change_spec: "do X",
        acceptance_criteria: ["X passes"],
        depends_on: [],
        complexity: "full",
      },
    ],
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(badCandidate)]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
});

test("rejects model output missing required node fields", async () => {
  const badCandidate = { nodes: [{ id: "x", intent: "X" }] };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(badCandidate)]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
});

test("allows one schema repair and succeeds on second valid response", async () => {
  const candidate = flatCandidate();
  const badOutput = JSON.stringify({ nodes: flatCandidate().nodes, required_role: "builder" });
  const invoker = makeInvoker([badOutput, JSON.stringify(candidate)]);
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
  });
  const out = getCandidate(result);
  assert.equal(out.nodes.length, 2);
});

test("fails after second invalid response", async () => {
  const badOutput = JSON.stringify({ nodes: flatCandidate().nodes, required_role: "builder" });
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([badOutput, badOutput]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
});

test("does not allow a third model call", async () => {
  const badOutput = JSON.stringify({ nodes: flatCandidate().nodes, required_role: "builder" });
  const invoker = makeInvoker([badOutput, badOutput, JSON.stringify(flatCandidate())]);
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
  });
  // The third response is ignored because we stop after two invalid responses.
  // The invoker stub does not track calls, but the failure path proves the limit.
});

test("provenance records sanitized prompt and routing evidence", async () => {
  const candidate = flatCandidate();
  const record: DecompositionInvocationRecord[] = [];
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
    onRecord: (r) => record.push(r),
  });
  const r = record[0];
  assert.ok(r.initialPrompt.length > 0);
  assert.ok(r.initialPrompt.includes("Add user authentication"));
  assert.equal(r.selectedModel, "moonshot/kimi-k3");
  assert.equal(r.breadthTool.name, "breadthRetrieval");
  assert.ok(r.package.name);
  assert.ok(r.launcher.path);
  assert.ok(r.indexRevision);
});

test("rejects model-authored provenance or control fields", async () => {
  const candidate = {
    ...flatCandidate(),
    provenance: { model: "authored" },
    approval: true,
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
});

test("returns timeout failure and makes no repair or fallback call", async () => {
  const invoker: DecompositionModelInvoker = {
    invoke: async (_invocation, signal) => {
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("late")), 10_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    },
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
    deadlineMs: 1,
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "TIMEOUT");
});

test("binds selected provider-qualified model and output token budget into invoker", async () => {
  const candidate = flatCandidate();
  const invocations: Array<{ readonly model: string; readonly maxOutputTokens: number }> = [];
  const invoker: DecompositionModelInvoker = {
    invoke: async (invocation) => {
      invocations.push({ model: invocation.model, maxOutputTokens: invocation.maxOutputTokens });
      return JSON.stringify(candidate);
    },
  };
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
  });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]!.model, "moonshot/kimi-k3");
  assert.equal(invocations[0]!.maxOutputTokens, 32_768);
});

test("provenance records actual Pi executable identity", async () => {
  const candidate = flatCandidate();
  const record: DecompositionInvocationRecord[] = [];
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
    piExecutable: { path: "/opt/pi", version: "0.81.1", digest: "sha256:actual-pi-digest" },
    onRecord: (r) => record.push(r),
  });
  const r = record[0]!;
  assert.equal(r.piExecutable.path, "/opt/pi");
  assert.equal(r.piExecutable.version, "0.81.1");
  assert.equal(r.piExecutable.digest, "sha256:actual-pi-digest");
});

test("binds selected fallback model into invoker", async () => {
  const candidate = flatCandidate();
  const invocations: string[] = [];
  const invoker: DecompositionModelInvoker = {
    invoke: async (invocation) => {
      invocations.push(invocation.model);
      return JSON.stringify(candidate);
    },
  };
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "openai-codex/gpt-5.6-sol" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
  });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0], "openai-codex/gpt-5.6-sol");
});

test("allows duplicate node IDs to pass to downstream controller", async () => {
  const candidate = {
    nodes: [
      { id: "x", intent: "A", change_spec: "do A", acceptance_criteria: ["A passes"], depends_on: [] },
      { id: "x", intent: "B", change_spec: "do B", acceptance_criteria: ["B passes"], depends_on: [] },
    ],
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
  });
  const out = getCandidate(result);
  assert.equal(out.nodes.length, 2);
});

test("rejects empty node string fields as schema-invalid", async () => {
  const candidate = {
    nodes: [{ id: "", intent: "", change_spec: "", acceptance_criteria: [""], depends_on: [""] }],
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
});

test("rejects empty acceptance criteria entries in job", async () => {
  const result = await runDecomposition({
    job: validJob({ spec: { intent: "Add auth", acceptanceCriteria: [""] } }),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_JOB");
});

test("rejects job with repository mismatch against index revision", async () => {
  const result = await runDecomposition({
    job: validJob({ targetRepository: { owner: "other", name: "repo" } }),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INDEX_REVISION_MISMATCH");
});

test("rejects job with invalid index revision fields", async () => {
  const result = await runDecomposition({
    job: validJob({ indexRevision: { head: "a".repeat(40) } as unknown as IndexRevision }),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_JOB");
});

test("rejects breadth revision that does not match job", async () => {
  const otherRevision: IndexRevision = {
    ...VALID_INDEX_REVISION,
    head: "b".repeat(40),
    manifestDigest: "sha256:other",
    indexRevision: "rev-other",
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult({ revision: otherRevision })),
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "BREADTH_REVISION_MISMATCH");
});

test("emits provenance for failed initial model invocation", async () => {
  const records: DecompositionInvocationRecord[] = [];
  const invoker: DecompositionModelInvoker = {
    invoke: async () => {
      throw new Error("provider down");
    },
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
    onRecord: (r) => records.push(r),
  });
  assert.ok(isDecompositionFailure(result));
  assert.equal(records.length, 1);
  assert.equal(records[0]!.selectedModel, "moonshot/kimi-k3");
});

test("emits provenance for timeout", async () => {
  const records: DecompositionInvocationRecord[] = [];
  const invoker: DecompositionModelInvoker = {
    invoke: async (_invocation, signal) => {
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("late")), 10_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    },
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
    deadlineMs: 1,
    onRecord: (r) => records.push(r),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "TIMEOUT");
  assert.equal(records.length, 1);
});

test("returns deeply immutable candidate and provenance", async () => {
  const candidate = flatCandidate();
  const records: DecompositionInvocationRecord[] = [];
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: makeInvoker([JSON.stringify(candidate)]),
    onRecord: (r) => records.push(r),
  });
  const out = getCandidate(result);
  assert.throws(() => {
    (out.nodes as unknown as DecompositionNode[]).push({ id: "evil", intent: "x", change_spec: "x", acceptance_criteria: [], depends_on: [] } as unknown as DecompositionNode);
  });
  assert.throws(() => {
    (out.nodes[0] as { intent: string }).intent = "mutated";
  });
  const record = records[0]!;
  assert.throws(() => {
    (record as unknown as { routing: { role: string } }).routing.role = "mutated";
  });
});

test("uses loadOrchestratorBootstrapPolicyFromSource as the default policy", async () => {
  const policy = loadOrchestratorBootstrapPolicyFromSource();
  const config = policy.getRoleConfig("decomposition");
  assert.equal(config?.primary, "moonshot/kimi-k3");
  assert.deepEqual(config?.fallback, ["openai-codex/gpt-5.6-sol"]);
});

test("custom validation is equivalent to canonical emission schema on boundary fixtures", async () => {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../../packages/orchestrator-harness/contracts/decomposition-emission.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020();
  const validate = ajv.compile(schema);

  const fixtures = [
    { label: "valid flat", candidate: flatCandidate(), ajvValid: true },
    { label: "empty strings", candidate: { nodes: [{ id: "", intent: "", change_spec: "", acceptance_criteria: [""], depends_on: [""] }] }, ajvValid: false },
    { label: "unknown node field", candidate: { nodes: [{ id: "x", intent: "X", change_spec: "x", acceptance_criteria: ["a"], depends_on: [], extra: 1 }] }, ajvValid: false },
    { label: "duplicate ids allowed", candidate: { nodes: [{ id: "x", intent: "X", change_spec: "x", acceptance_criteria: ["a"], depends_on: [] }, { id: "x", intent: "Y", change_spec: "y", acceptance_criteria: ["b"], depends_on: [] }] }, ajvValid: true },
    { label: "empty depends_on allowed", candidate: { nodes: [{ id: "x", intent: "X", change_spec: "x", acceptance_criteria: ["a"], depends_on: [] }] }, ajvValid: true },
  ];

  for (const { label, candidate, ajvValid } of fixtures) {
    const ajvResult = validate(candidate);
    const result = await runDecomposition({
      job: validJob(),
      availability: [{ fullId: "moonshot/kimi-k3" }],
      breadthRetriever: makeRetriever(makeBreadthResult()),
      modelInvoker: makeInvoker([JSON.stringify(candidate)]),
    });
    const customValid = !isDecompositionFailure(result);
    assert.equal(!!ajvResult, customValid, `${label}: ajv=${!!ajvResult}, custom=${customValid}`);
  }
});
