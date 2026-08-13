import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { consumeQueueEnvelope, deriveAttemptId, deriveCriterionId, deriveJobId, dispatchReadyFrontier, projectAttemptContract, validateLeaseCommand, validateQueueEnvelope } from '../../src/domains/orchestration/index.ts';
import { validateAttemptContracts } from '../../src/domains/agent-execution/index.ts';
import type { OrchestrationStore } from '../../src/domains/orchestration/sqlite-store.ts';
import { cleanRoot, createQueue, createReadyAttempt, node, openStore, openStoreWithWork, approvedWork, makeResult, tempRoot, testBuilderRoutingResolver } from './controller-ready-frontier.fixtures.ts';

describe('CAS lifecycle', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('increments version on valid transition', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(approvedWork());
    const n = await store.transitionNode('work-1', 'a', 1, 'ready');
    assert.ok(!('error' in n));
    assert.equal((n as { version: number }).version, 2);
    const n2 = await store.transitionNode('work-1', 'a', 2, 'in_progress');
    assert.equal((n2 as { version: number }).version, 3);
  });

  it('rejects stale expected version', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(approvedWork());
    await store.transitionNode('work-1', 'a', 1, 'ready');
    const result = await store.transitionNode('work-1', 'a', 1, 'in_progress');
    assert.ok('error' in result);
  });

  it('rejects invalid transitions', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(approvedWork());
    const result = await store.transitionNode('work-1', 'a', 1, 'passed');
    assert.ok('error' in result);
  });
});

describe('dispatch service', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('creates one attempt and one job per ready node', async () => {
    const store = await openStore(root);
    const queue = createQueue();
    await store.importApprovedWork(approvedWork());
    const result = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', new Map(), testBuilderRoutingResolver);
    assert.equal(result.dispatched.length, 1);
    const [{ attempt_id, job_id }] = result.dispatched;
    assert.equal(attempt_id, deriveAttemptId('work-1', 'a', 1));
    assert.equal(job_id, deriveJobId(attempt_id));
    assert.equal(queue.jobs.size, 1);
  });

  it('duplicate dispatch is idempotent', async () => {
    const store = await openStore(root);
    const queue = createQueue();
    await store.importApprovedWork(approvedWork());
    const first = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', new Map(), testBuilderRoutingResolver);
    const second = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', new Map(), testBuilderRoutingResolver);
    assert.equal(first.dispatched.length, 1);
    assert.deepEqual(second.dispatched, first.dispatched);
    assert.equal(queue.jobs.size, 1);
  });

  it('respects scheduling blockers from predicted-touch', async () => {
    const store = await openStore(root);
    const queue = createQueue();
    await store.importApprovedWork(approvedWork({ nodes: [node('a'), node('b')] }));
    const blockers = new Map([['b', 'a']]);
    const result = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', blockers, testBuilderRoutingResolver);
    assert.deepEqual(result.dispatched.map((d) => deriveAttemptId('work-1', 'a', 1)), [deriveAttemptId('work-1', 'a', 1)]);
  });
});

describe('queue schema and rehydration', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('rejects envelopes with unknown fields', () => {
    const result = validateQueueEnvelope({ job_id: 'j', attempt_id: 'a', node_id: 'n', work_id: 'w', extra: 1 });
    assert.ok(result);
  });

  it('rejects envelopes with nested topology', () => {
    const result = validateQueueEnvelope({ job_id: 'j', attempt_id: 'a', node_id: 'n', work_id: 'w', depends_on: ['x'] });
    assert.ok(result);
  });

  it('rejects oversized identifiers', () => {
    const longId = 'x'.repeat(201);
    const result = validateQueueEnvelope({ job_id: longId, attempt_id: 'a', node_id: 'n', work_id: 'w' });
    assert.ok(result);
  });

  it('rejects tampered envelope identities via consumer', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const jobId = deriveJobId(attemptId);
    const tampered = { job_id: jobId, attempt_id: attemptId, node_id: 'b', work_id: 'work-1' };
    const result = await consumeQueueEnvelope(store, tampered, { nodeId: 'a', attemptId, targetRepo: 'owner/repo', targetBranch: 'main' });
    assert.ok('error' in result);
  });

  it('rehydrates the immutable attempt from SQLite for a valid envelope', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(approvedWork());
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const jobId = deriveJobId(attemptId);
    const result = await consumeQueueEnvelope(store, { job_id: jobId, attempt_id: attemptId, node_id: 'a', work_id: 'work-1' }, {
      nodeId: 'a',
      attemptId,
      targetRepo: 'owner/repo',
      targetBranch: 'main',
    });
    assert.ok(!('error' in result));
    const contract = (result as { contract: Record<string, unknown> }).contract;
    assert.equal(contract.node_id, 'a');
    assert.equal(contract.attempt_id, attemptId);
    assert.ok(!Object.hasOwn(contract, 'depends_on'));
  });

  it('rejects content-bearing queue envelopes', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const jobId = deriveJobId(attemptId);
    const envelope = { job_id: jobId, attempt_id: attemptId, node_id: 'a', work_id: 'work-1', acceptance_criteria: ['tamper'] };
    const result = await consumeQueueEnvelope(store, envelope, { nodeId: 'a', attemptId, targetRepo: 'owner/repo', targetBranch: 'main' });
    assert.ok('error' in result);
  });

  it('rejects queue envelopes with tampered target or topology fields', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const jobId = deriveJobId(attemptId);
    const withTarget = { job_id: jobId, attempt_id: attemptId, node_id: 'a', work_id: 'work-1', target_repo: 'other/repo' };
    const withTopology = { job_id: jobId, attempt_id: attemptId, node_id: 'a', work_id: 'work-1', depends_on: ['b'] };
    assert.ok('error' in await consumeQueueEnvelope(store, withTarget, { nodeId: 'a', attemptId, targetRepo: 'owner/repo', targetBranch: 'main' }));
    assert.ok('error' in await consumeQueueEnvelope(store, withTopology, { nodeId: 'a', attemptId, targetRepo: 'owner/repo', targetBranch: 'main' }));
  });
});

describe('worker projection', () => {
  it('produces a topology-free contract validated by Agent Execution', () => {
    const n = node('a', [], { acceptance_criteria: ['  whitespace  ', 'second'] });
    const contract = projectAttemptContract(n, 'work-1', deriveAttemptId('work-1', 'a', 1), 1, 'owner/repo', 'main');
    const validated = validateAttemptContracts([contract], {
      nodeId: 'a',
      attemptId: deriveAttemptId('work-1', 'a', 1),
      targetRepo: 'owner/repo',
      targetBranch: 'main',
    });
    assert.ok(!('code' in validated));
    assert.equal((validated as unknown as { contract: { acceptance_criteria: readonly { id: string; text: string }[] } }).contract.acceptance_criteria.length, 2);
  });

  it('produces stable criterion ids', () => {
    const n = node('a', [], { acceptance_criteria: ['first', 'second'] });
    const id1 = deriveCriterionId('work-1', 'a', 0, 'first');
    const id2 = deriveCriterionId('work-1', 'a', 0, 'first');
    assert.equal(id1, id2);
  });

  it('is deeply immutable', () => {
    const n = node('a', [], { acceptance_criteria: ['first'] });
    const contract = projectAttemptContract(n, 'work-1', deriveAttemptId('work-1', 'a', 1), 1, 'owner/repo', 'main') as Record<string, unknown>;
    assert.throws(() => { (contract as Record<string, unknown>).intent = 'mutated'; });
    const criteria = contract.acceptance_criteria as Array<Record<string, unknown>>;
    assert.throws(() => { criteria.push({ id: 'x', text: 'y' }); });
    assert.throws(() => { criteria[0]!.text = 'mutated'; });
  });
});

describe('lease commands and concurrency', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('only one owner wins concurrent claim', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const [r1, r2] = await Promise.all([
      store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner-1' }, new Date(Date.now() + 60_000), new Date()),
      store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner-2' }, new Date(Date.now() + 60_000), new Date()),
    ]);
    const winners = [r1, r2].filter((r) => !('error' in r));
    assert.equal(winners.length, 1);
  });

  it('rejects wrong token on renew', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const renew = await store.renewLease({ kind: 'renew', attempt_id: attemptId, owner: 'owner', token: 'wrong' }, new Date(Date.now() + 120_000), new Date());
    assert.ok('error' in renew);
  });

  it('rejects wrong owner on renew and release', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const token = (claim as { token: string }).token;
    const renew = await store.renewLease({ kind: 'renew', attempt_id: attemptId, owner: 'other', token }, new Date(Date.now() + 120_000), new Date());
    assert.ok('error' in renew);
    const release = await store.releaseLease({ kind: 'release', attempt_id: attemptId, owner: 'other', token }, new Date());
    assert.ok(!release.ok);
  });

  it('reclaim increases generation and makes attempt claimable again', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const first = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in first));
    const firstGen = (first as { generation: number }).generation;

    const reclaim = await store.reclaimLease(attemptId, 'reconciliation', new Date(Date.now() + 100_000));
    assert.ok(!('error' in reclaim));
    const reclaimGen = (reclaim as { generation: number }).generation;
    assert.ok(reclaimGen > firstGen);

    const attempt = await store.getAttempt(attemptId);
    assert.equal(attempt?.state, 'created');

    const second = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner2' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in second));
    assert.equal((second as { generation: number }).generation, reclaimGen);
  });

  it('rejects reclaim of an unexpired lease', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    const reclaim = await store.reclaimLease(attemptId, 'reconciliation', new Date());
    assert.ok('error' in reclaim);
  });

  it('rejects malformed lease commands', async () => {
    assert.ok(validateLeaseCommand({ kind: 'claim', attempt_id: 'a', owner: 'o', extra: 1 }));
    assert.ok(validateLeaseCommand({ kind: 'renew', attempt_id: 'a', owner: 'o' }));
    assert.ok(validateLeaseCommand({ kind: 'claim', attempt_id: '', owner: 'o' }));
  });
});

describe('lease-fenced result acceptance', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('rejects stale generation result after reclaim', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const first = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in first));
    const firstToken = (first as { token: string }).token;
    const firstGen = (first as { generation: number }).generation;
    const versionBefore = (await store.listNodes('work-1')).find((n) => n.node_id === 'a')!.version;

    const reclaim = await store.reclaimLease(attemptId, 'owner2', new Date(Date.now() + 100_000));
    assert.ok(!('error' in reclaim));

    const stale = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token: firstToken, generation: firstGen, expected_node_version: versionBefore });
    const result = await store.acceptResult(stale, new Date());
    assert.ok('error' in result || !result.ok);
    assert.equal((await store.getAcceptedResult(attemptId)), null);
    const nodeAfter = (await store.listNodes('work-1')).find((n) => n.node_id === 'a');
    assert.equal(nodeAfter?.state, 'ready');
    assert.equal(nodeAfter?.version, versionBefore);
  });

  it('rejects stale token result with current generation after reclaim', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const first = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in first));
    const firstToken = (first as { token: string }).token;
    const firstGen = (first as { generation: number }).generation;

    const reclaim = await store.reclaimLease(attemptId, 'owner2', new Date(Date.now() + 100_000));
    assert.ok(!('error' in reclaim));
    const reclaimGen = (reclaim as { generation: number }).generation;

    const staleToken = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token: firstToken, generation: reclaimGen, expected_node_version: 2 });
    const result = await store.acceptResult(staleToken, new Date());
    assert.ok('error' in result || !result.ok);
  });

  it('rejects result with mismatched identity', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const wrongNode = makeResult({ attempt_id: attemptId, node_id: 'b', work_id: 'work-1', token, generation, expected_node_version: 2 });
    assert.ok('error' in await store.acceptResult(wrongNode, new Date()) || !(await store.acceptResult(wrongNode, new Date())).ok);
    const wrongWork = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-2', token, generation, expected_node_version: 2 });
    assert.ok('error' in await store.acceptResult(wrongWork, new Date()) || !(await store.acceptResult(wrongWork, new Date())).ok);
  });

  it('rejects oversized result fields', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const oversized = makeResult({ result_id: 'x'.repeat(201), attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 2 });
    const result = await store.acceptResult(oversized, new Date());
    assert.ok('error' in result || !result.ok);
  });

  it('rejects result with wrong expected node version', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const wrongVersion = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 99 });
    const result = await store.acceptResult(wrongVersion, new Date());
    assert.ok('error' in result || !result.ok);
  });

  it('duplicate identical result is an audited no-op', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const res = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 2 });
    const first = await store.acceptResult(res, new Date());
    assert.ok(!('error' in first) && first.ok);
    const second = await store.acceptResult(res, new Date());
    assert.ok(!('error' in second) && second.ok);
    const accepted = await store.getAcceptedResult(attemptId);
    assert.ok(accepted);
  });

  it('conflicting result id is rejected', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const first = makeResult({ result_id: 'res-1', attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 2, outcome: 'passed' });
    await store.acceptResult(first, new Date());
    const conflict = makeResult({ result_id: 'res-1', attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 2, outcome: 'failed' });
    const result = await store.acceptResult(conflict, new Date());
    assert.ok('error' in result || !result.ok);
  });

  it('failed result completes as failed', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    await store.transitionNode('work-1', 'a', 2, 'in_progress');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    assert.ok(!('error' in claim));
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const res = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 3, outcome: 'failed' });
    const accepted = await store.acceptResult(res, new Date());
    assert.ok(!('error' in accepted) && accepted.ok);
    const completed = await store.completeAuthorizedResult('work-1', 'a', attemptId);
    assert.ok(!('error' in completed));
    const node = await store.listNodes('work-1');
    assert.equal(node.find((n) => n.node_id === 'a')?.state, 'failed');
  });

  it('rejects results with unknown or topology-bearing fields', async () => {
    const result = { result_id: 'r', attempt_id: 'a', node_id: 'n', work_id: 'w', outcome: 'passed', phase: 'R', token: 't', generation: 1, expected_node_version: 1, depends_on: ['x'] };
    assert.ok(validateQueueEnvelope(result));
  });
});

describe('accepted-result recovery and completion authorization', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('completes an authorized result using the persisted expected version', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    await store.transitionNode('work-1', 'a', 2, 'in_progress');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const res = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 3 });
    await store.acceptResult(res, new Date());
    const completed = await store.completeAuthorizedResult('work-1', 'a', attemptId);
    assert.ok(!('error' in completed));
    const node = (await store.listNodes('work-1')).find((n) => n.node_id === 'a');
    assert.equal(node?.state, 'passed');
  });

  it('rejects completion when node version has drifted', async () => {
    const store = await openStoreWithWork(root);
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    await store.transitionNode('work-1', 'a', 2, 'in_progress');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const res = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 3 });
    await store.acceptResult(res, new Date());
    const passed = await store.transitionNode('work-1', 'a', 3, 'passed');
    assert.ok(!('error' in passed));
    const completed = await store.completeAuthorizedResult('work-1', 'a', attemptId);
    assert.ok('error' in completed);
    assert.equal((completed as { error: { code: string } }).error.code, 'STALE_VERSION');
  });
});
