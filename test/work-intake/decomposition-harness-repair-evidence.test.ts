import test from 'node:test';
import assert from 'node:assert/strict';
import type { DecompositionInvocationRecord, DecompositionModelInvoker, DecompositionNode } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { isDecompositionFailure } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { runDecomposition } from '../../src/domains/work-intake/decomposition-harness.ts';
import { loadOrchestratorBootstrapPolicyFromSource } from '../../src/domains/model-routing-and-evaluation/bootstrap-policy.ts';
import { flatCandidate, getCandidate, getFailure, makeBreadthResult, makeInvoker, makeRetriever, validJob } from './decomposition-harness.fixtures.ts';
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

test("does not allow a third model call after an invalid repair", async () => {
  const badOutput = JSON.stringify({ nodes: flatCandidate().nodes, required_role: "builder" });
  const invocations: Array<{ readonly prompt: string; readonly model: string }> = [];
  let calls = 0;
  const invoker: DecompositionModelInvoker = {
    invoke: async (invocation) => {
      calls += 1;
      if (calls === 3) throw new Error('third-call sentinel');
      invocations.push({ prompt: invocation.prompt, model: invocation.model });
      return badOutput;
    },
  };
  const result = await runDecomposition({
    job: validJob(),
    availability: [{ fullId: "moonshot/kimi-k3" }],
    breadthRetriever: makeRetriever(makeBreadthResult()),
    modelInvoker: invoker,
  });
  const failure = getFailure(result);
  assert.equal(failure.code, "INVALID_OUTPUT");
  assert.equal(calls, 2, 'the third-call sentinel must not be reached');
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1]!.model, invocations[0]!.model);
  assert.ok(invocations[1]!.prompt.includes('REPAIR INSTRUCTIONS'));
  assert.ok(invocations[1]!.prompt.includes('Add user authentication'));
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
