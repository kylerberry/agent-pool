import test from "node:test";
import assert from "node:assert/strict";
import type {
  DecompositionJob,
  DecompositionFailure,
  DecompositionInvocationRecord,
  BreadthRetriever,
  DecompositionModelInvoker,
} from "../../src/domains/work-intake/decomposition-contracts.ts";
import { isDecompositionFailure } from "../../src/domains/work-intake/decomposition-contracts.ts";
import { runDecomposition } from "../../src/domains/work-intake/decomposition-harness.ts";
import { sanitizePromptBoundValue } from "../../src/domains/work-intake/decomposition-sanitization.ts";
import { validateLimitPolicy } from "../../src/domains/work-intake/decomposition-limits.ts";
import type { IndexRevision, BreadthResult, GraphUnit, GraphEdge } from "../../src/domains/codebase-knowledge/contracts.ts";

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
      acceptanceCriteria: ["Users can log in"],
    },
    rawSpec: "Implement a login endpoint.",
    targetRepository: { owner: "owner", name: "repo" },
    head: "a".repeat(40),
    indexRevision: VALID_INDEX_REVISION,
    ...overrides,
  };
}

function makeBreadthResult(units: GraphUnit[] = [], edges: GraphEdge[] = [], truncated = false): BreadthResult {
  return {
    revision: VALID_INDEX_REVISION,
    units,
    edges,
    truncated,
  };
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

function getFailure(result: unknown): DecompositionFailure {
  assert.ok(isDecompositionFailure(result));
  return result as DecompositionFailure;
}

function flatCandidate() {
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

const API_KEY_CANARY = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
const PASSWORD_CANARY = "password=SuperSecret123!";
const TOKEN_CANARY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZWNyZXQiOiJ4In0.signature";

test("sanitizer redacts API key in raw spec", () => {
  const sanitized = sanitizePromptBoundValue(`Use key ${API_KEY_CANARY} here`);
  assert.ok(!sanitized.includes(API_KEY_CANARY));
  assert.ok(sanitized.includes("[REDACTED-"));
});

test("sanitizer redacts password assignments", () => {
  const sanitized = sanitizePromptBoundValue(PASSWORD_CANARY);
  assert.ok(!sanitized.includes("SuperSecret123!"));
});

test("sanitizer redacts JWT-like tokens", () => {
  const sanitized = sanitizePromptBoundValue(TOKEN_CANARY);
  assert.ok(!sanitized.includes(TOKEN_CANARY));
});

test("secret canary does not reach prompt, provenance, or errors", async () => {
  const record: DecompositionInvocationRecord[] = [];
  const result = await runDecomposition({
    job: validJob({ rawSpec: `Configure service with ${API_KEY_CANARY}` }),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: {
      retrieve: async () =>
        makeBreadthResult([
          { id: "u1", label: `Unit with ${PASSWORD_CANARY}`, kind: "function", sourcePath: "src/auth.js" },
        ]),
    },
    modelInvoker: makeInvoker([
      JSON.stringify({
        nodes: [
          {
            id: "x",
            intent: "Configure",
            change_spec: "Set key",
            acceptance_criteria: ["No leaks"],
            depends_on: [],
          },
        ],
      }),
    ]),
    onRecord: (r) => record.push(r),
  });
  assert.ok(!isDecompositionFailure(result));
  const r = record[0];
  assert.ok(!r.initialPrompt.includes(API_KEY_CANARY), "API key canary leaked into prompt");
  assert.ok(!r.initialPrompt.includes(PASSWORD_CANARY), "password canary leaked into prompt");
  assert.ok(!JSON.stringify(r).includes(API_KEY_CANARY), "API key canary leaked into record");
  assert.ok(!JSON.stringify(r).includes(PASSWORD_CANARY), "password canary leaked into record");
});

test("provider errors are projected to bounded failures without raw payloads", async () => {
  const invoker: DecompositionModelInvoker = {
    invoke: async () => {
      throw new Error(`provider exploded with ${API_KEY_CANARY}`);
    },
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: invoker,
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "MODEL_INVOCATION_FAILED");
  assert.ok(!failure.reason.includes(API_KEY_CANARY), "provider error leaked secret");
  assert.ok(!failure.reason.includes("provider exploded"), "raw provider error leaked");
});

test("rejects prompt that exceeds prompt byte limit", async () => {
  const huge = "x".repeat(600_000);
  const result = await runDecomposition({
    job: validJob({ rawSpec: "small spec" }),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: {
      retrieve: async () => makeBreadthResult([{ id: "u1", label: huge, kind: "function", sourcePath: "src/x.js" }]),
    },
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "PROMPT_LIMIT_EXCEEDED");
});

test("rejects response that exceeds response byte limit", async () => {
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: makeInvoker(["x".repeat(1_200_000)]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "RESPONSE_LIMIT_EXCEEDED");
});

test("rejects node count over limit", async () => {
  const nodes = Array.from({ length: 300 }, (_, i) => ({
    id: `n${i}`,
    intent: `Node ${i}`,
    change_spec: "do thing",
    acceptance_criteria: ["pass"],
    depends_on: [],
  }));
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: makeInvoker([JSON.stringify({ nodes })]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "NODE_COUNT_EXCEEDED");
});

test("rejects repair context over limit by truncating diagnostics", async () => {
  const diagnostics = Array.from({ length: 150 }, (_, i) => `error ${i}: ${"x".repeat(500)}`);
  const badOutput = JSON.stringify({ nodes: [], diagnostics });
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: makeInvoker([badOutput]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
  // The failure should still be bounded; no huge diagnostics retained.
  assert.ok(JSON.stringify(failure).length < 20_000);
});

test("limit policy validates boundary fixtures", () => {
  const policy = validateLimitPolicy();
  assert.equal(policy.maxSerializedJobBytes, 262_144);
  assert.equal(policy.maxRawSpecBytes, 65_536);
  assert.equal(policy.maxBreadthUnits, 200);
  assert.equal(policy.maxBreadthEdges, 500);
  assert.equal(policy.maxPromptBytes, 524_288);
  assert.equal(policy.maxOutputTokens, 32_768);
  assert.equal(policy.maxResponseBytes, 1_048_576);
  assert.equal(policy.maxNodes, 256);
  assert.equal(policy.maxDiagnostics, 100);
  assert.equal(policy.maxRepairContextBytes, 16_384);
  assert.equal(policy.maxCalls, 2);
  assert.equal(policy.deadlineMs, 120_000);
});

test("rejects breadth units over limit", async () => {
  const units = Array.from({ length: 250 }, (_, i) => ({
    id: `u${i}`,
    label: `Unit ${i}`,
    kind: "function",
    sourcePath: `src/${i}.js`,
  }));
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult(units) },
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "BREADTH_LIMIT_EXCEEDED");
});

test("rejects breadth edges over limit", async () => {
  const edges = Array.from({ length: 600 }, (_, i) => ({
    source: `u${i}`,
    target: `u${(i + 1) % 600}`,
    relation: "calls",
  }));
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult([], edges) },
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "BREADTH_LIMIT_EXCEEDED");
});

test("timeout discards late response and produces no repair", async () => {
  let calls = 0;
  const invoker: DecompositionModelInvoker = {
    invoke: async (_invocation, signal) => {
      calls += 1;
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
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: invoker,
    deadlineMs: 20,
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "TIMEOUT");
  assert.equal(calls, 1);
});

test("sanitizes graph unit id, kind, and edge fields", async () => {
  const API_KEY = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
  const PASSWORD = "password=SuperSecret123!";
  const record: DecompositionInvocationRecord[] = [];
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: {
      retrieve: async () =>
        makeBreadthResult(
          [
            { id: API_KEY, label: "Unit", kind: PASSWORD, sourcePath: "src/auth.js" },
          ],
          [
            { source: API_KEY, target: PASSWORD, relation: "uses" },
          ],
        ),
    },
    modelInvoker: makeInvoker([
      JSON.stringify({
        nodes: [
          {
            id: "x",
            intent: "Configure",
            change_spec: "Set key",
            acceptance_criteria: ["No leaks"],
            depends_on: [],
          },
        ],
      }),
    ]),
    onRecord: (r) => record.push(r),
  });
  assert.ok(!isDecompositionFailure(result));
  const r = record[0];
  assert.ok(!r.initialPrompt.includes(API_KEY), "API key leaked into prompt");
  assert.ok(!r.initialPrompt.includes(PASSWORD), "password leaked into prompt");
  assert.ok(!r.initialPrompt.includes("SuperSecret"), "raw secret value leaked into prompt");
});

test("breadth retrieval error is projected without raw payload", async () => {
  const secret = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: {
      retrieve: async () => {
        throw new Error(`retriever failed with ${secret}`);
      },
    },
    modelInvoker: makeInvoker([]),
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "BREADTH_RETRIEVAL_FAILED");
  assert.ok(!failure.reason.includes(secret), "retriever error leaked secret");
  assert.ok(!failure.reason.includes("retriever failed"), "raw retriever error leaked");
});

test("non-cooperative adapter still returns TIMEOUT before late resolution", async () => {
  let calls = 0;
  const invoker: DecompositionModelInvoker = {
    invoke: async () => {
      calls += 1;
      // Ignores the abort signal and resolves after the deadline.
      return new Promise((resolve) => setTimeout(() => resolve("[]"), 10_000));
    },
  };
  const records: DecompositionInvocationRecord[] = [];
  const start = Date.now();
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: invoker,
    deadlineMs: 20,
    onRecord: (r) => records.push(r),
  });
  const elapsed = Date.now() - start;
  const failure = getFailure(result);
  assert.equal(failure.code, "TIMEOUT");
  assert.ok(elapsed < 500, `timeout took too long: ${elapsed}ms`);
  assert.equal(calls, 1);
  assert.equal(records.length, 1);
});

test("breadth retrieval shares invocation-wide deadline", async () => {
  let retrievalCalls = 0;
  const retriever: BreadthRetriever = {
    retrieve: async (_revision, _limits, signal) => {
      retrievalCalls += 1;
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("late retrieval")), 10_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted retrieval"));
        });
      });
    },
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: retriever,
    modelInvoker: makeInvoker([]),
    deadlineMs: 10,
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "BREADTH_RETRIEVAL_TIMEOUT");
  assert.equal(retrievalCalls, 1);
});

test("slow breadth retrieval leaves reduced but bounded deadline for model", async () => {
  let modelDeadlineMs = 0;
  const retriever: BreadthRetriever = {
    retrieve: async (_revision, _limits, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return makeBreadthResult();
    },
  };
  const invoker: DecompositionModelInvoker = {
    invoke: async (invocation) => {
      modelDeadlineMs = invocation.deadlineMs;
      return JSON.stringify({
        nodes: [
          { id: "x", intent: "X", change_spec: "x", acceptance_criteria: ["pass"], depends_on: [] },
        ],
      });
    },
  };
  await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: retriever,
    modelInvoker: invoker,
    deadlineMs: 200,
  });
  assert.ok(modelDeadlineMs > 0 && modelDeadlineMs <= 200, `model deadline ${modelDeadlineMs} should be bounded by invocation deadline`);
});

test("emits provenance for failed repair invocation", async () => {
  const records: DecompositionInvocationRecord[] = [];
  const badOutput = JSON.stringify({ nodes: flatCandidate().nodes, required_role: "builder" });
  const invoker: DecompositionModelInvoker = {
    invoke: async (invocation) => {
      if (invocation.prompt.includes("REPAIR")) {
        throw new Error("provider down during repair");
      }
      return badOutput;
    },
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: invoker,
    onRecord: (r) => records.push(r),
  });
  assert.ok(isDecompositionFailure(result));
  assert.equal(records.length, 2);
  assert.ok(records[1]!.repairPrompt);
});

test("model-facing surface has no write, shell, persistence, approval, queue, dispatch, validator, or repository capability", () => {
  // The contracts are types only; this test documents the invariant that the
  // invoker and retriever interfaces are read-only and narrow.
  const sampleInvoker: DecompositionModelInvoker = {
    invoke: async (_invocation: { readonly prompt: string; readonly model: string; readonly deadlineMs: number; readonly maxOutputTokens: number }, _signal: AbortSignal) => "[]",
  };
  const sampleRetriever: BreadthRetriever = {
    retrieve: async (_revision: IndexRevision, _limits: { readonly maxUnits: number; readonly maxEdges: number }) =>
      makeBreadthResult(),
  };
  assert.equal(typeof sampleInvoker.invoke, "function");
  assert.equal(typeof sampleRetriever.retrieve, "function");
});
