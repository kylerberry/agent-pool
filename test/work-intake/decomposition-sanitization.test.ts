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
test("rejects inherited, class-instance, and cyclic jobs without calling collaborators", async () => {
  const inherited = Object.create(validJob()) as DecompositionJob;
  class JobEnvelope {
    readonly jobId = "job-1";
    readonly spec = validJob().spec;
    readonly rawSpec = validJob().rawSpec;
    readonly targetRepository = validJob().targetRepository;
    readonly head = validJob().head;
    readonly indexRevision = validJob().indexRevision;
  }
  const cyclic = validJob() as DecompositionJob & { self?: unknown };
  cyclic.self = cyclic;

  for (const job of [inherited, new JobEnvelope() as DecompositionJob, cyclic]) {
    let breadthCalls = 0;
    let modelCalls = 0;
    const invocation = runDecomposition({
      job,
      availability: [{ fullId: "moonshot/kimi-k3" }],
      breadthRetriever: { retrieve: async () => { breadthCalls += 1; return makeBreadthResult(); } },
      modelInvoker: { invoke: async () => { modelCalls += 1; return JSON.stringify(flatCandidate()); } },
    });
    await assert.doesNotReject(() => invocation);
    const failure = getFailure(await invocation);
    assert.equal(failure.code, "INVALID_JOB");
    assert.ok(failure.reason.length <= 256, "invalid-job reason must remain bounded");
    assert.equal(breadthCalls, 0, "invalid jobs must not call breadth retrieval");
    assert.equal(modelCalls, 0, "invalid jobs must not call the model");
  }
});
