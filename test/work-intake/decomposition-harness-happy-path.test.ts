import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecomposition } from '../../src/domains/work-intake/decomposition-harness.ts';
import { isDecompositionFailure } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { convergentCandidate, flatCandidate, getCandidate, getFailure, makeBreadthResult, makeInvoker, makeRetriever, validJob } from './decomposition-harness.fixtures.ts';
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
