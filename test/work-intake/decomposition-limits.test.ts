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
