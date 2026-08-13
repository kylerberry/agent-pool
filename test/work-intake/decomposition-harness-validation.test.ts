import test from 'node:test';
import assert from 'node:assert/strict';
import type { DecompositionJob } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { isDecompositionFailure } from '../../src/domains/work-intake/decomposition-contracts.ts';
import { runDecomposition } from '../../src/domains/work-intake/decomposition-harness.ts';
import type { IndexRevision } from '../../src/domains/codebase-knowledge/contracts.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { VALID_INDEX_REVISION, flatCandidate, getCandidate, getFailure, makeBreadthResult, makeInvoker, makeRetriever, validJob } from './decomposition-harness.fixtures.ts';
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
