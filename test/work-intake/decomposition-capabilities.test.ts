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

test("decomposition harness imports no controller or worker capability modules", () => {
  const source = fileURLToPath(new URL("../../src/domains/work-intake/decomposition-harness.ts", import.meta.url));
  assertNoModuleReferences(source, [
    "../orchestration/index.ts",
    "../agent-execution/index.ts",
    "../verification/index.ts",
    "worker-harness",
    "craft-pool",
  ]);
});
test("rejects model emissions that request forbidden capabilities", async () => {
  let invocations = 0;
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: { retrieve: async () => makeBreadthResult() },
    modelInvoker: {
      invoke: async () => {
        invocations += 1;
        return JSON.stringify({
          nodes: [{
            id: "x",
            intent: "Attempt capability escalation",
            change_spec: "Request an unauthorized tool",
            acceptance_criteria: ["Must not be accepted"],
            depends_on: [],
            capabilities: ["write", "shell", "persistence", "approval", "queue", "dispatch", "validator", "repository"],
          }],
        });
      },
    },
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
  assert.match(failure.reason, /unknown node fields: capabilities/);
  assert.equal(invocations, 2, "one schema-only repair may not accept a capability request");
});
