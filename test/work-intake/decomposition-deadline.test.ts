import test from 'node:test';
import assert from 'node:assert/strict';
import type { BreadthRetriever, DecompositionJob, DecompositionInvocationRecord, DecompositionModelInvoker } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { isDecompositionFailure } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { runDecomposition } from '../../src/domains/work-intake/decomposition-harness.ts';
import { sanitizePromptBoundValue } from '../../src/domains/work-intake/decomposition-sanitization.ts';
import { validateLimitPolicy } from '../../src/domains/work-intake/decomposition-limits.ts';
import { fileURLToPath } from 'node:url';
import { assertNoModuleReferences } from '../helpers/import-policy.ts';
import { getFailure, makeBreadthResult, makeInvoker, validJob } from './decomposition-harness.fixtures.ts';
import { API_KEY_CANARY, PASSWORD_CANARY, TOKEN_CANARY, flatCandidate } from './decomposition-security.fixtures.ts';

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
