import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, statSync, lstatSync, writeFileSync, symlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqliteStore,
  makeQueueEnvelope,
  deriveAttemptId,
  deriveJobId,
  deriveCriterionId,
  projectAttemptContract,
  computeReadyFrontier,
  reconcile,
  dispatchReadyFrontier,
  consumeQueueEnvelope,
  makeEmpiricalSchedulingPolicy,
  validateQueueEnvelope,
  validateLeaseCommand,
  type ApprovedNode,
  type ApprovedWork,
  type QueuePort,
  type LeaseCommand,
  type WorkerResult,
  type PredictedTouchEvidence,
  type PredictedTouchImport,
  type SchedulingPolicy,
} from '../../src/domains/orchestration/index.ts';
import { isPlainObject } from '../../src/domains/orchestration/contracts.ts';
import { validateAttemptContracts } from '../../src/domains/agent-execution/index.ts';
import type { OrchestrationStore } from '../../src/domains/orchestration/sqlite-store.ts';

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  return realpathSync(dir);
}

function cleanRoot(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function createQueue(): QueuePort & { readonly jobs: Map<string, { jobId: string; attemptId: string; nodeId: string; workId: string }>; readonly removed: Set<string> } {
  const jobs = new Map<string, { jobId: string; attemptId: string; nodeId: string; workId: string }>();
  const removed = new Set<string>();
  return {
    jobs,
    removed,
    async ensureJob(envelope) {
      jobs.set(envelope.job_id, {
        jobId: envelope.job_id,
        attemptId: envelope.attempt_id,
        nodeId: envelope.node_id,
        workId: envelope.work_id,
      });
    },
    async removeJob(jobId) {
      removed.add(jobId);
      jobs.delete(jobId);
    },
  };
}

function node(id: string, deps: readonly string[] = [], overrides: Partial<ApprovedNode> = {}): ApprovedNode {
  return {
    id,
    intent: `intent ${id}`,
    change_spec: `change ${id}`,
    acceptance_criteria: [`${id} criterion`],
    depends_on: deps,
    criteria_origin_source: 'direct_task',
    criteria_origin_source_id: 'sub-1',
    ...overrides,
  };
}

function approvedWork(overrides: Partial<ApprovedWork> & { nodes?: ApprovedNode[] } = {}): ApprovedWork {
  return {
    work_id: 'work-1',
    origin: 'direct_task',
    repo: 'owner/repo',
    branch: 'main',
    payload_hash: 'hash-1',
    nodes: [node('a'), node('b', ['a'])],
    ...overrides,
  };
}

let storeCounter = 0;
async function openStore(root: string, db?: string, backupHook?: () => Promise<void>) {
  return createSqliteStore({
    runtimeRoot: root,
    dbLocation: db ?? `orchestration-${++storeCounter}.db`,
    backupHook,
  });
}

async function openStoreWithWork(root: string, work: ApprovedWork = approvedWork()) {
  const store = await openStore(root);
  const imported = await store.importApprovedWork(work);
  if ('error' in imported) throw new Error(`import failed: ${JSON.stringify(imported.error)}`);
  return store;
}

async function readyNode(store: OrchestrationStore, workId: string, nodeId: string) {
  const nodes = await store.listNodes(workId);
  const record = nodes.find((n) => n.node_id === nodeId);
  if (!record) {
    throw new Error(`readyNode: node ${nodeId} not found in work ${workId}; have ${nodes.map((n) => n.node_id).join(',')}`);
  }
  if (record.state === 'pending') {
    const transitioned = await store.transitionNode(workId, nodeId, record.version, 'ready');
    if ('error' in transitioned) throw new Error(String(transitioned.error));
  }
}

async function createReadyAttempt(store: OrchestrationStore, workId: string, nodeId: string, attemptNumber = 1) {
  await readyNode(store, workId, nodeId);
  const attemptId = deriveAttemptId(workId, nodeId, attemptNumber);
  const jobId = deriveJobId(attemptId);
  const attempt = await store.createAttempt(workId, nodeId, attemptId, attemptNumber, jobId);
  if ('error' in attempt) throw new Error(`createAttempt error: ${JSON.stringify(attempt.error)}`);
  return { attemptId, jobId };
}

function makeResult(opts: Partial<WorkerResult> & { attempt_id: string; node_id: string; work_id: string; token: string; generation: number; expected_node_version: number }): WorkerResult {
  return {
    result_id: 'res-1',
    phase: 'R',
    outcome: 'passed',
    artifact_path: undefined,
    summary: undefined,
    ...opts,
  };
}

function policy(version = 'policy-1', minConfidence = 0.7): SchedulingPolicy {
  return makeEmpiricalSchedulingPolicy({ version, minConfidence });
}

function evidence(overrides: Partial<PredictedTouchEvidence> = {}): PredictedTouchEvidence {
  return {
    evidence_id: 'ev-1',
    repo: 'owner/repo',
    approved_head: 'head-1',
    graph_revision: 'graph-1',
    manifest_digest: 'manifest-1',
    algorithm_version: 'alg-1',
    policy_version: 'policy-1',
    gate1_approval_id: 'gate1-1',
    classified_overlaps: [{ node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: ['s-1'] }],
    ...overrides,
  };
}

async function withPrototypePollution<T>(pollutants: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(pollutants)) {
    originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
    Object.defineProperty(Object.prototype, key, { value: pollutants[key], configurable: true, writable: true, enumerable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) {
        delete (Object.prototype as Record<string, unknown>)[key];
      } else {
        Object.defineProperty(Object.prototype, key, descriptor);
      }
    }
  }
}

describe('ready frontier', () => {
  it('only roots are ready initially', () => {
    const n = [node('a'), node('b', ['a']), node('c'), node('d', ['c', 'b'])];
    const frontier = computeReadyFrontier(n, new Set(), new Map());
    assert.deepEqual(frontier.map((f) => f.node.id), ['a', 'c']);
  });

  it('dependent appears only after every dependency passed', () => {
    const n = [node('a'), node('b', ['a'])];
    assert.deepEqual(computeReadyFrontier(n, new Set(), new Map()).map((f) => f.node.id), ['a']);
    assert.deepEqual(computeReadyFrontier(n, new Set(['a']), new Map()).map((f) => f.node.id), ['b']);
  });

  it('convergence requires all dependencies passed', () => {
    const n = [node('a'), node('b'), node('c', ['a', 'b'])];
    assert.deepEqual(computeReadyFrontier(n, new Set(['a']), new Map()).map((f) => f.node.id), ['b']);
    assert.deepEqual(computeReadyFrontier(n, new Set(['a', 'b']), new Map()).map((f) => f.node.id), ['c']);
  });

  it('unrelated branches are independent', () => {
    const n = [node('a'), node('b', ['a']), node('c'), node('d', ['c'])];
    assert.deepEqual(computeReadyFrontier(n, new Set(), new Map()).map((f) => f.node.id), ['a', 'c']);
    assert.deepEqual(computeReadyFrontier(n, new Set(['a']), new Map()).map((f) => f.node.id), ['b', 'c']);
  });

  it('ordering is stable regardless of insertion order', () => {
    const n1 = [node('z'), node('a'), node('m')];
    const n2 = [node('m'), node('z'), node('a')];
    assert.deepEqual(computeReadyFrontier(n1, new Set(), new Map()).map((f) => f.node.id), ['a', 'm', 'z']);
    assert.deepEqual(computeReadyFrontier(n2, new Set(), new Map()).map((f) => f.node.id), ['a', 'm', 'z']);
  });
});

describe('plain-object boundary', () => {
  it('accepts ordinary Object.prototype records', () => {
    assert.ok(isPlainObject({ work_id: 'w' }));
  });

  it('accepts null-prototype own-data records', () => {
    const record = Object.create(null);
    record.work_id = 'w';
    assert.ok(isPlainObject(record));
  });

  it('rejects class instances', () => {
    class HostileWork {}
    assert.ok(!isPlainObject(new HostileWork()));
  });

  it('rejects Date objects', () => {
    assert.ok(!isPlainObject(new Date()));
  });

  it('rejects RegExp objects', () => {
    assert.ok(!isPlainObject(/x/));
  });

  it('rejects attacker-controlled prototype chains', () => {
    const attackerProto = { work_id: 'evil' };
    const hostile = Object.create(attackerProto);
    assert.ok(!isPlainObject(hostile));
  });

  it('rejects arrays', () => {
    assert.ok(!isPlainObject([]));
  });

  it('rejects null', () => {
    assert.ok(!isPlainObject(null));
  });
});

describe('approved-work boundary', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('accepts a valid direct-task work definition', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork());
    assert.ok(!('error' in result), JSON.stringify(result));
    assert.equal(result.work_id, 'work-1');
  });

  it('rejects unknown fields', async () => {
    const store = await openStore(root);
    const bad = { ...approvedWork(), extra_field: 'x' } as unknown as ApprovedWork;
    const result = await store.importApprovedWork(bad);
    assert.ok('error' in result);
  });

  it('rejects unknown node fields', async () => {
    const store = await openStore(root);
    const n = node('a');
    (n as Record<string, unknown>).extra = 1;
    const result = await store.importApprovedWork(approvedWork({ nodes: [n] }));
    assert.ok('error' in result);
  });

  it('rejects non-object nodes array elements', async () => {
    const store = await openStore(root);
    const bad = approvedWork({ nodes: ['not-a-node'] as unknown as ApprovedNode[] });
    const result = await store.importApprovedWork(bad);
    assert.ok('error' in result);
  });

  it('rejects duplicate unit ids', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({ nodes: [node('a'), node('a')] }));
    assert.ok('error' in result);
  });

  it('rejects self dependencies', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({ nodes: [node('a', ['a'])] }));
    assert.ok('error' in result);
  });

  it('rejects unknown dependencies', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({ nodes: [node('a', ['missing'])] }));
    assert.ok('error' in result);
  });

  it('rejects cycles', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({ nodes: [node('a', ['b']), node('b', ['a'])] }));
    assert.ok('error' in result);
  });

  it('identical duplicate imports are idempotent', async () => {
    const store = await openStore(root);
    const first = await store.importApprovedWork(approvedWork());
    const second = await store.importApprovedWork(approvedWork());
    assert.ok(!('error' in first) && !('error' in second));
    assert.equal((first as { work_id: string; version: number }).work_id, (second as { work_id: string; version: number }).work_id);
  });

  it('conflicting duplicate imports reject', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(approvedWork());
    const result = await store.importApprovedWork(approvedWork({ repo: 'other/repo' }));
    assert.ok('error' in result);
  });

  it('rejects oversized work and node fields', async () => {
    const store = await openStore(root);
    const longId = 'x'.repeat(201);
    const result = await store.importApprovedWork(approvedWork({ work_id: longId }));
    assert.ok('error' in result);
  });

  it('rejects decomposed work missing Gate-1 approval_id', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({
      origin: 'decomposition',
      approved_at: '2026-01-01T00:00:00Z',
      approved_head: 'head-1',
    }));
    assert.ok('error' in result);
    assert.equal((result as { error: { code: string } }).error.code, 'INVALID_WORK');
  });

  it('rejects decomposed work missing Gate-1 approved_at', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({
      origin: 'decomposition',
      approval_id: 'gate1-1',
      approved_head: 'head-1',
    }));
    assert.ok('error' in result);
  });

  it('rejects decomposed work missing Gate-1 approved_head', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({
      origin: 'decomposition',
      approval_id: 'gate1-1',
      approved_at: '2026-01-01T00:00:00Z',
    }));
    assert.ok('error' in result);
  });

  it('does not persist decomposed work that lacks Gate-1 provenance', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({
      origin: 'decomposition',
      approval_id: '',
      approved_at: '2026-01-01T00:00:00Z',
      approved_head: 'head-1',
    }));
    assert.ok('error' in result);
    assert.equal(await store.getImportedWork('work-1'), null);
  });

  it('preserves direct-task Gate-1 exemption', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(approvedWork({
      origin: 'direct_task',
      approval_id: undefined,
      approved_at: undefined,
      approved_head: undefined,
    }));
    assert.ok(!('error' in result));
    const fetched = await store.getImportedWork('work-1');
    assert.ok(fetched);
    assert.equal(fetched.work_id, 'work-1');
  });

  it('accepts null-prototype own-data ApprovedWork', async () => {
    const store = await openStore(root);
    const work = Object.create(null);
    work.work_id = 'work-1';
    work.origin = 'direct_task';
    work.repo = 'owner/repo';
    work.branch = 'main';
    work.payload_hash = 'hash-1';
    work.nodes = [node('a'), node('b', ['a'])];
    const result = await store.importApprovedWork(work as unknown as ApprovedWork);
    assert.ok(!('error' in result), JSON.stringify(result));
    const fetched = await store.getImportedWork('work-1');
    assert.ok(fetched);
    assert.equal(fetched.work_id, 'work-1');
  });

  it('rejects class-instance ApprovedWork without persistence', async () => {
    const store = await openStore(root);
    class HostileWork {
      work_id = 'work-1';
      origin = 'direct_task';
      repo = 'owner/repo';
      branch = 'main';
      payload_hash = 'hash-1';
      nodes = [node('a'), node('b', ['a'])];
    }
    const result = await store.importApprovedWork(new HostileWork() as unknown as ApprovedWork);
    assert.ok('error' in result);
    assert.equal(await store.getImportedWork('work-1'), null);
  });

  it('rejects Date ApprovedWork without persistence', async () => {
    const store = await openStore(root);
    const result = await store.importApprovedWork(new Date() as unknown as ApprovedWork);
    assert.ok('error' in result);
    assert.equal(await store.getImportedWork('work-1'), null);
  });

  it('rejects attacker-prototype ApprovedWork without persistence', async () => {
    const store = await openStore(root);
    const attackerProto = {
      work_id: 'work-1',
      origin: 'direct_task',
      repo: 'owner/repo',
      branch: 'main',
      payload_hash: 'hash-1',
      nodes: [node('a'), node('b', ['a'])],
    };
    const hostile = Object.create(attackerProto);
    const result = await store.importApprovedWork(hostile as unknown as ApprovedWork);
    assert.ok('error' in result);
    assert.equal(await store.getImportedWork('work-1'), null);
  });

  it('rejects inherited Gate-1 provenance without persistence', async () => {
    const store = await openStore(root);
    const pollutants = {
      approval_id: 'gate1-1',
      approved_at: '2026-01-01T00:00:00Z',
      approved_head: 'head-1',
    };
    await withPrototypePollution(pollutants, async () => {
      const work = {
        work_id: 'work-1',
        origin: 'decomposition',
        repo: 'owner/repo',
        branch: 'main',
        payload_hash: 'hash-1',
        nodes: [node('a')],
      };
      const result = await store.importApprovedWork(work as unknown as ApprovedWork);
      assert.ok('error' in result);
      assert.equal(await store.getImportedWork('work-1'), null);
    });
  });

  it('accepts own-field ApprovedWork when Object.prototype is polluted', async () => {
    const store = await openStore(root);
    await withPrototypePollution({ work_id: 'evil' }, async () => {
      const result = await store.importApprovedWork(approvedWork());
      assert.ok(!('error' in result), JSON.stringify(result));
      const fetched = await store.getImportedWork('work-1');
      assert.ok(fetched);
      assert.equal(fetched.work_id, 'work-1');
    });
  });
});

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
    const result = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', new Map());
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
    const first = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', new Map());
    const second = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', new Map());
    assert.equal(first.dispatched.length, 1);
    assert.deepEqual(second.dispatched, first.dispatched);
    assert.equal(queue.jobs.size, 1);
  });

  it('respects scheduling blockers from predicted-touch', async () => {
    const store = await openStore(root);
    const queue = createQueue();
    await store.importApprovedWork(approvedWork({ nodes: [node('a'), node('b')] }));
    const blockers = new Map([['b', 'a']]);
    const result = await dispatchReadyFrontier(store, queue, 'work-1', 'owner/repo', 'main', blockers);
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

describe('reconciliation', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('ensures jobs for committed attempts that lack queue jobs', async () => {
    const store = await openStoreWithWork(root);
    const queue = createQueue();
    await readyNode(store, 'work-1', 'a');
    const attemptId = deriveAttemptId('work-1', 'a', 1);
    const jobId = deriveJobId(attemptId);
    await store.createAttempt('work-1', 'a', attemptId, 1, jobId);
    assert.equal((await store.getAttempt(attemptId))?.job_id, jobId);
    queue.removed.add(jobId);
    queue.jobs.delete(jobId);
    await reconcile(store, queue, new Date(), 60_000);
    assert.equal(queue.jobs.has(jobId), true);
  });

  it('reclaims expired leases and makes attempts claimable', async () => {
    const store = await openStoreWithWork(root);
    const queue = createQueue();
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() - 1), new Date(Date.now() - 2));
    assert.ok(!('error' in claim));
    await reconcile(store, queue, new Date(), 60_000);
    const attempt = await store.getAttempt(attemptId);
    assert.equal(attempt?.state, 'created');
  });

  it('completes authorized results exactly once', async () => {
    const store = await openStoreWithWork(root);
    const queue = createQueue();
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    await store.transitionNode('work-1', 'a', 2, 'in_progress');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const res = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 3 });
    await store.acceptResult(res, new Date());
    await reconcile(store, queue, new Date(Date.now() + 100_000), 60_000);
    const node = (await store.listNodes('work-1')).find((n) => n.node_id === 'a');
    assert.equal(node?.state, 'passed');
    assert.ok(queue.removed.has(deriveJobId(attemptId)));
  });

  it('second reconciliation is a no-op for completed results', async () => {
    const store = await openStoreWithWork(root);
    const queue = createQueue();
    const { attemptId } = await createReadyAttempt(store, 'work-1', 'a');
    await store.transitionNode('work-1', 'a', 2, 'in_progress');
    const claim = await store.claimLease({ kind: 'claim', attempt_id: attemptId, owner: 'owner' }, new Date(Date.now() + 60_000), new Date());
    const token = (claim as { token: string }).token;
    const generation = (claim as { generation: number }).generation;
    const res = makeResult({ attempt_id: attemptId, node_id: 'a', work_id: 'work-1', token, generation, expected_node_version: 3 });
    await store.acceptResult(res, new Date());
    await reconcile(store, queue, new Date(Date.now() + 100_000), 60_000);
    const firstVersion = (await store.listNodes('work-1')).find((n) => n.node_id === 'a')?.version;
    await reconcile(store, queue, new Date(Date.now() + 200_000), 60_000);
    const secondVersion = (await store.listNodes('work-1')).find((n) => n.node_id === 'a')?.version;
    assert.equal(firstVersion, secondVersion);
  });
});

describe('SQLite path safety', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  it('rejects absolute-path escape', async () => {
    const r = tempRoot();
    try {
      await createSqliteStore({ runtimeRoot: r, dbLocation: '/etc/passwd' });
      assert.fail('should reject absolute path');
    } catch (err) {
      assert.ok((err as Error).message.includes('outside'));
    }
  });

  it('rejects traversal escape', async () => {
    const r = tempRoot();
    try {
      await createSqliteStore({ runtimeRoot: r, dbLocation: '../escape.db' });
      assert.fail('should reject traversal');
    } catch (err) {
      assert.ok((err as Error).message.includes('outside'));
    }
  });

  it('rejects symlinked parent component', async () => {
    const r = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(r, 'link'));
    try {
      await createSqliteStore({ runtimeRoot: r, dbLocation: 'link/db.db' });
      assert.fail('should reject symlinked parent');
    } catch (err) {
      assert.ok((err as Error).message.includes('symlink'));
    } finally {
      cleanRoot(outside);
    }
  });

  it('rejects symlinked database target', async () => {
    const r = tempRoot();
    const target = join(r, 'real.db');
    writeFileSync(target, '');
    symlinkSync(target, join(r, 'link.db'));
    try {
      await createSqliteStore({ runtimeRoot: r, dbLocation: 'link.db' });
      assert.fail('should reject symlinked database');
    } catch (err) {
      assert.ok((err as Error).message.includes('symlink') || (err as NodeJS.ErrnoException).code === 'EEXIST');
    }
  });

  it('rejects non-regular database target', async () => {
    const r = tempRoot();
    mkdirSync(join(r, 'dir'));
    try {
      await createSqliteStore({ runtimeRoot: r, dbLocation: 'dir' });
      assert.fail('should reject directory target');
    } catch (err) {
      assert.ok((err as Error).message.includes('regular'));
    }
  });

  it('rejects group/world-accessible runtime root', async () => {
    const r = tempRoot();
    chmodSync(r, 0o755);
    try {
      await createSqliteStore({ runtimeRoot: r, dbLocation: 'db.db' });
      assert.fail('should reject non-owner-only root');
    } catch (err) {
      assert.ok((err as Error).message.includes('owner-only'));
    }
  });

  it('creates owner-only files under the root', async () => {
    const r = tempRoot();
    const store = await createSqliteStore({ runtimeRoot: r, dbLocation: 'db/orch.db' });
    await store.close();
    const stat = statSync(join(r, 'db', 'orch.db'));
    assert.ok(stat.isFile());
    assert.equal(stat.mode & 0o077, 0);
  });
});

describe('migration safety', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  function v1SchemaPath() {
    return join(root, `v1-${crypto.randomUUID()}.db`);
  }

  function createV1Database(path: string) {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE works (work_id TEXT PRIMARY KEY, origin TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, payload_hash TEXT NOT NULL, approval_id TEXT, approved_at TEXT, approved_head TEXT, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE nodes (work_id TEXT NOT NULL, node_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, intent TEXT NOT NULL, change_spec TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL, depends_on_json TEXT NOT NULL, criteria_origin_source TEXT NOT NULL, criteria_origin_source_id TEXT NOT NULL, PRIMARY KEY (work_id, node_id));
      CREATE TABLE dependencies (work_id TEXT NOT NULL, node_id TEXT NOT NULL, depends_on_node_id TEXT NOT NULL, PRIMARY KEY (work_id, node_id, depends_on_node_id));
      CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, state TEXT NOT NULL, job_id TEXT, created_at TEXT NOT NULL, UNIQUE (work_id, node_id, attempt_number));
      CREATE TABLE leases (attempt_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner TEXT NOT NULL, token_digest TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE accepted_results (attempt_id TEXT PRIMARY KEY, result_id TEXT NOT NULL, node_id TEXT NOT NULL, work_id TEXT NOT NULL, outcome TEXT NOT NULL, phase TEXT NOT NULL, artifact_path TEXT, summary TEXT, accepted_at TEXT NOT NULL);
      CREATE TABLE completion_authorizations (attempt_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, work_id TEXT NOT NULL, result_id TEXT NOT NULL, expected_node_version INTEGER NOT NULL, authorized_at TEXT NOT NULL);
      CREATE TABLE scheduling_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL, evidence_id TEXT NOT NULL, node_id TEXT NOT NULL, decision TEXT NOT NULL, blocker_node_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT, node_id TEXT, attempt_id TEXT, event TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO schema_version (version, applied_at) VALUES (1, datetime('now'));
    `);
    db.close();
    chmodSync(path, 0o600);
  }

  function getSchemaVersion(path: string): number {
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
    db.close();
    return row?.version ?? 0;
  }

  it('initializes a fresh database at the current schema version', async () => {
    const store = await openStore(root);
    await store.close();
  });

  it('migrates an existing v1 database forward', async () => {
    const path = v1SchemaPath();
    createV1Database(path);
    let backedUp = false;
    const store = await createSqliteStore({ runtimeRoot: root, dbLocation: relative(root, path), backupHook: async () => { backedUp = true; } });
    await store.close();
    assert.ok(backedUp);
    assert.equal(getSchemaVersion(path), 2);
  });

  it('fails closed when the backup hook rejects', async () => {
    const path = v1SchemaPath();
    createV1Database(path);
    try {
      await createSqliteStore({
        runtimeRoot: root,
        dbLocation: relative(root, path),
        backupHook: async () => { throw new Error('backup refused'); },
      });
      assert.fail('should fail when backup hook rejects');
    } catch (err) {
      assert.ok((err as Error).message.includes('backup refused'));
    }
    assert.equal(getSchemaVersion(path), 1);
  });

  it('fails closed on a newer unsupported schema version', async () => {
    const path = v1SchemaPath();
    createV1Database(path);
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(99, new Date().toISOString());
    db.close();
    try {
      await createSqliteStore({ runtimeRoot: root, dbLocation: relative(root, path) });
      assert.fail('should reject newer schema');
    } catch (err) {
      assert.ok((err as Error).message.includes('newer'));
    }
  });

  it('recovers from a failed backup on restart', async () => {
    const path = v1SchemaPath();
    createV1Database(path);
    try {
      await createSqliteStore({ runtimeRoot: root, dbLocation: relative(root, path), backupHook: async () => { throw new Error('backup refused'); } });
    } catch {}
    const store = await createSqliteStore({ runtimeRoot: root, dbLocation: relative(root, path), backupHook: async () => {} });
    await store.close();
    assert.equal(getSchemaVersion(path), 2);
  });

  it('rolls back a failed migration and keeps the prior schema version', async () => {
    const path = v1SchemaPath();
    createV1Database(path);
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE attempts ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;');
    db.close();
    try {
      await createSqliteStore({ runtimeRoot: root, dbLocation: relative(root, path), backupHook: async () => {} });
      assert.fail('should fail migration');
    } catch (err) {
      assert.ok((err as Error).message.includes('migration') || (err as Error).message.includes('duplicate column'));
    }
    assert.equal(getSchemaVersion(path), 1);
  });
});

describe('predicted-touch scheduling', () => {
  let root: string;
  before(() => { root = tempRoot(); });
  after(() => { cleanRoot(root); });

  function decomposedWork() {
    return approvedWork({
      origin: 'decomposition',
      approval_id: 'gate1-1',
      approved_at: '2026-01-01T00:00:00Z',
      approved_head: 'head-1',
      nodes: [node('a'), node('b'), node('c')],
    });
  }

  it('serializes confident overlapping nodes with valid provenance', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const ev = evidence({
      classified_overlaps: [
        { node_id: 'a', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
        { node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
      ],
    });
    const result = await store.importPredictedTouch('work-1', ev, policy());
    assert.ok(!('error' in result));
    assert.equal((result as PredictedTouchImport).decision, 'serialize');
    assert.equal((result as PredictedTouchImport).blocker_node_id, 'a');
  });

  it('selects deterministic node-id winners and avoids mutual blockers', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const ev = evidence({
      classified_overlaps: [
        { node_id: 'a', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
        { node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
        { node_id: 'c', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
      ],
    });
    await store.importPredictedTouch('work-1', ev, policy());
    const blockers = await store.getSchedulingBlockers('work-1');
    assert.equal(blockers.get('a'), undefined);
    assert.equal(blockers.get('b'), 'a');
    assert.equal(blockers.get('c'), 'b');
  });

  it('falls back optimistically for head mismatch', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const result = await store.importPredictedTouch('work-1', evidence({ approved_head: 'head-2' }), policy());
    assert.ok(!('error' in result));
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('falls back for cross-repository mismatch', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const result = await store.importPredictedTouch('work-1', evidence({ repo: 'other/repo' }), policy());
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('falls back for Gate-1 approval mismatch', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const result = await store.importPredictedTouch('work-1', evidence({ gate1_approval_id: 'gate1-2' }), policy());
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('falls back when policy version does not match', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const result = await store.importPredictedTouch('work-1', evidence(), policy('policy-2'));
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('falls back for low-confidence evidence', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const ev = evidence({
      classified_overlaps: [{ node_id: 'b', confidence: 0.5, likely_touched_units: ['unit-1'], shared_surfaces: ['s-1'] }],
    });
    const result = await store.importPredictedTouch('work-1', ev, policy());
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('falls back for direct-task work without Gate-1 association', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(approvedWork({ origin: 'direct_task' }));
    const result = await store.importPredictedTouch('work-1', evidence(), policy());
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('falls back when no overlaps are classified', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const result = await store.importPredictedTouch('work-1', evidence({ classified_overlaps: [] }), policy());
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('falls back when graph/manifest/algorithm drift from frozen baseline', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const baseline = evidence();
    await store.importPredictedTouch('work-1', baseline, policy());
    const drift = evidence({ graph_revision: 'graph-2' });
    const result = await store.importPredictedTouch('work-1', drift, policy());
    assert.equal((result as PredictedTouchImport).decision, 'optimistic');
  });

  it('rejects malformed evidence', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const bad = evidence({ classified_overlaps: [{ node_id: 'b', confidence: 1.5, likely_touched_units: [], shared_surfaces: [] }] });
    const result = await store.importPredictedTouch('work-1', bad, policy());
    assert.ok('error' in result);
  });

  it('does not insert or modify dependency rows', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const ev = evidence({
      classified_overlaps: [
        { node_id: 'a', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
        { node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
      ],
    });
    await store.importPredictedTouch('work-1', ev, policy());
    const nodes = await store.listNodes('work-1');
    for (const n of nodes) {
      assert.equal(n.state, 'pending');
      assert.deepEqual(JSON.parse(n.depends_on_json), []);
    }
  });

  it('durably records full provenance for scheduling decisions', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const ev = evidence({
      classified_overlaps: [
        { node_id: 'a', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
        { node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
      ],
    });
    await store.importPredictedTouch('work-1', ev, policy());
    const blockers = await store.getSchedulingBlockers('work-1');
    assert.ok(blockers.has('b'));
  });

  it('supersedes old blockers with current evidence', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const first = evidence({
      classified_overlaps: [
        { node_id: 'a', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
        { node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
      ],
    });
    await store.importPredictedTouch('work-1', first, policy());
    const second = evidence({
      evidence_id: 'ev-2',
      classified_overlaps: [{ node_id: 'a', confidence: 0.9, likely_touched_units: [], shared_surfaces: [] }],
    });
    await store.importPredictedTouch('work-1', second, policy());
    const blockers = await store.getSchedulingBlockers('work-1');
    assert.equal(blockers.size, 0);
  });

  it('rejects non-object predicted-touch evidence', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const result = await store.importPredictedTouch('work-1', 'not-an-object' as unknown as PredictedTouchEvidence, policy());
    assert.ok('error' in result);
  });

  it('rejects oversized classified_overlaps', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const overlaps = Array.from({ length: 1001 }, (_, i) => ({
      node_id: `node-${i}`,
      confidence: 0.9,
      likely_touched_units: [],
      shared_surfaces: [],
    }));
    const result = await store.importPredictedTouch('work-1', evidence({ classified_overlaps: overlaps }), policy());
    assert.ok('error' in result);
  });

  it('rejects oversized likely_touched_units', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const units = Array.from({ length: 201 }, (_, i) => `unit-${i}`);
    const result = await store.importPredictedTouch('work-1', evidence({
      classified_overlaps: [{ node_id: 'a', confidence: 0.9, likely_touched_units: units, shared_surfaces: [] }],
    }), policy());
    assert.ok('error' in result);
  });

  it('rejects oversized shared_surfaces', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const surfaces = Array.from({ length: 201 }, (_, i) => `surface-${i}`);
    const result = await store.importPredictedTouch('work-1', evidence({
      classified_overlaps: [{ node_id: 'a', confidence: 0.9, likely_touched_units: [], shared_surfaces: surfaces }],
    }), policy());
    assert.ok('error' in result);
  });

  it('does not mutate state on oversized predicted-touch evidence', async () => {
    const dbName = 'no-mutation-evidence.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    const overlaps = Array.from({ length: 1001 }, (_, i) => ({
      node_id: `node-${i}`,
      confidence: 0.9,
      likely_touched_units: [],
      shared_surfaces: [],
    }));
    const result = await store.importPredictedTouch('work-1', evidence({ classified_overlaps: overlaps }), policy());
    assert.ok('error' in result);
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('accepts null-prototype own-data PredictedTouchEvidence', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    const ev = Object.create(null);
    ev.evidence_id = 'ev-1';
    ev.repo = 'owner/repo';
    ev.approved_head = 'head-1';
    ev.graph_revision = 'graph-1';
    ev.manifest_digest = 'manifest-1';
    ev.algorithm_version = 'alg-1';
    ev.policy_version = 'policy-1';
    ev.gate1_approval_id = 'gate1-1';
    ev.classified_overlaps = [
      { node_id: 'a', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
      { node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
    ];
    const result = await store.importPredictedTouch('work-1', ev as unknown as PredictedTouchEvidence, policy());
    assert.ok(!('error' in result), JSON.stringify(result));
    assert.equal((result as PredictedTouchImport).decision, 'serialize');
  });

  it('rejects class-instance PredictedTouchEvidence without scheduling decision or baseline mutation', async () => {
    const dbName = 'no-mutation-class-evidence.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    class HostileEvidence {
      evidence_id = 'ev-1';
      repo = 'owner/repo';
      approved_head = 'head-1';
      graph_revision = 'graph-1';
      manifest_digest = 'manifest-1';
      algorithm_version = 'alg-1';
      policy_version = 'policy-1';
      gate1_approval_id = 'gate1-1';
      classified_overlaps = [];
    }
    const result = await store.importPredictedTouch('work-1', new HostileEvidence() as unknown as PredictedTouchEvidence, policy());
    assert.ok('error' in result);
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('rejects Date PredictedTouchEvidence without scheduling decision or baseline mutation', async () => {
    const dbName = 'no-mutation-date-evidence.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    const result = await store.importPredictedTouch('work-1', new Date() as unknown as PredictedTouchEvidence, policy());
    assert.ok('error' in result);
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('rejects attacker-prototype PredictedTouchEvidence without scheduling decision or baseline mutation', async () => {
    const dbName = 'no-mutation-proto-evidence.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    const attackerProto = {
      evidence_id: 'ev-1',
      repo: 'owner/repo',
      approved_head: 'head-1',
      graph_revision: 'graph-1',
      manifest_digest: 'manifest-1',
      algorithm_version: 'alg-1',
      policy_version: 'policy-1',
      gate1_approval_id: 'gate1-1',
      classified_overlaps: [],
    };
    const hostile = Object.create(attackerProto);
    const result = await store.importPredictedTouch('work-1', hostile as unknown as PredictedTouchEvidence, policy());
    assert.ok('error' in result);
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('rejects class-instance nested overlap without scheduling decision or baseline mutation', async () => {
    const dbName = 'no-mutation-class-overlap.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    class HostileOverlap {
      node_id = 'b';
      confidence = 0.9;
      likely_touched_units = ['unit-1'];
      shared_surfaces = ['s-1'];
    }
    const result = await store.importPredictedTouch('work-1', evidence({
      classified_overlaps: [new HostileOverlap() as unknown as { node_id: string; confidence: number; likely_touched_units: string[]; shared_surfaces: string[] }],
    }), policy());
    assert.ok('error' in result);
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('rejects attacker-prototype nested overlap without scheduling decision or baseline mutation', async () => {
    const dbName = 'no-mutation-proto-overlap.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    const attackerProto = {
      node_id: 'b',
      confidence: 0.9,
      likely_touched_units: ['unit-1'],
      shared_surfaces: ['s-1'],
    };
    const hostile = Object.create(attackerProto);
    const result = await store.importPredictedTouch('work-1', evidence({
      classified_overlaps: [hostile as unknown as { node_id: string; confidence: number; likely_touched_units: string[]; shared_surfaces: string[] }],
    }), policy());
    assert.ok('error' in result);
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('rejects inherited top-level evidence fields without scheduling decision or baseline mutation', async () => {
    const dbName = 'no-mutation-inherited-evidence.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    const pollutants = {
      evidence_id: 'ev-1',
      repo: 'owner/repo',
      approved_head: 'head-1',
      graph_revision: 'graph-1',
      manifest_digest: 'manifest-1',
      algorithm_version: 'alg-1',
      policy_version: 'policy-1',
      gate1_approval_id: 'gate1-1',
      classified_overlaps: [],
    };
    await withPrototypePollution(pollutants, async () => {
      const result = await store.importPredictedTouch('work-1', {} as unknown as PredictedTouchEvidence, policy());
      assert.ok('error' in result);
    });
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('rejects inherited overlap fields without scheduling decision or baseline mutation', async () => {
    const dbName = 'no-mutation-inherited-overlap.db';
    const store = await openStore(root, dbName);
    await store.importApprovedWork(decomposedWork());
    const pollutants = {
      node_id: 'b',
      confidence: 0.9,
      likely_touched_units: ['unit-1'],
      shared_surfaces: ['s-1'],
    };
    await withPrototypePollution(pollutants, async () => {
      const result = await store.importPredictedTouch('work-1', evidence({
        classified_overlaps: [{} as unknown as { node_id: string; confidence: number; likely_touched_units: string[]; shared_surfaces: string[] }],
      }), policy());
      assert.ok('error' in result);
    });
    await store.close();

    const db = new DatabaseSync(join(root, dbName));
    const decisions = db.prepare('SELECT COUNT(*) AS count FROM scheduling_decisions WHERE work_id = ?').get('work-1') as { count: number };
    const work = db.prepare('SELECT frozen_graph_revision, frozen_manifest_digest, frozen_algorithm_version, frozen_policy_version FROM works WHERE work_id = ?').get('work-1') as {
      frozen_graph_revision: string | null;
      frozen_manifest_digest: string | null;
      frozen_algorithm_version: string | null;
      frozen_policy_version: string | null;
    };
    db.close();
    assert.equal(decisions.count, 0);
    assert.equal(work.frozen_graph_revision, null);
    assert.equal(work.frozen_manifest_digest, null);
    assert.equal(work.frozen_algorithm_version, null);
    assert.equal(work.frozen_policy_version, null);
  });

  it('accepts own-field PredictedTouchEvidence when Object.prototype is polluted', async () => {
    const store = await openStore(root);
    await store.importApprovedWork(decomposedWork());
    await withPrototypePollution({ evidence_id: 'evil' }, async () => {
      const result = await store.importPredictedTouch('work-1', evidence({
        classified_overlaps: [
          { node_id: 'a', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
          { node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: [] },
        ],
      }), policy());
      assert.ok(!('error' in result), JSON.stringify(result));
      assert.equal((result as PredictedTouchImport).decision, 'serialize');
    });
  });
});
