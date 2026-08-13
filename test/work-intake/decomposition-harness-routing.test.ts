import test from 'node:test';
import assert from 'node:assert/strict';
import type { DecompositionInvocationRecord } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { runDecomposition } from '../../src/domains/work-intake/decomposition-harness.ts';
import { isDecompositionFailure } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { convergentCandidate, flatCandidate, getCandidate, getFailure, makeBreadthResult, makeInvoker, makeRetriever, validJob } from './decomposition-harness.fixtures.ts';
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
