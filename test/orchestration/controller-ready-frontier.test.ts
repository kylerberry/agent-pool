import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeReadyFrontier, type ApprovedNode, type ApprovedWork } from '../../src/domains/orchestration/index.ts';
import { isPlainObject } from '../../src/domains/orchestration/contracts.ts';
import { cleanRoot, node, openStore, approvedWork, tempRoot, withPrototypePollution } from './controller-ready-frontier.fixtures.ts';

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
