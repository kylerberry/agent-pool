import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAttemptId, deriveJobId, dispatchReadyFrontier, type QueuePort } from '../../src/domains/orchestration/index.ts';
import type { OrchestrationStore } from '../../src/domains/orchestration/sqlite-store.ts';
import { APPROVED_MODELS } from '../../src/domains/model-routing-and-evaluation/index.ts';
import { approvedWork, cleanRoot, createQueue, createStoreFixture, realResolver, tempRoot } from './attempt-provenance.fixtures.ts';

let root = '';
let fixture: ReturnType<typeof createStoreFixture>;
before(() => { root = tempRoot(); fixture = createStoreFixture(root); });
after(() => { cleanRoot(root); });

describe('attempt builder routing provenance', () => {
  it('persists the canonical builder selected at dispatch', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const attemptId = await fixture.makeAttempt(store, {
      builder: APPROVED_MODELS[0],
      policyVersion: 1,
    });
    const persisted = await store.getBuilderRoutingByAttemptId(attemptId);
    assert.equal(persisted?.builder_model, APPROVED_MODELS[0]);
    assert.equal(persisted?.policy_version, 1);
    await store.close();
  });

  it('returns null for an attempt that was never created', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    assert.equal(await store.getBuilderRoutingByAttemptId('att://work-1/missing/1'), null);
    await store.close();
  });

  it('rolls back the whole attempt when builder routing is outside the canonical registry', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const attemptId = deriveAttemptId('work-1', 'a', 1);
    const created = await store.createAttempt(
      'work-1',
      'a',
      attemptId,
      1,
      deriveJobId(attemptId),
      { builder: 'openai-codex/not-approved', policyVersion: 1 } as never,
    );
    assert.ok('error' in created, 'unapproved model must fail closed');
    assert.equal(await store.getAttempt(attemptId), null, 'no attempt row may survive');
    await store.close();
  });

  it('rolls back the whole attempt when builder routing is absent, expanded, or inherited', async () => {
    const inherited = Object.create({ builder: APPROVED_MODELS[0], policyVersion: 1 });
    for (const routing of [
      undefined,
      { builder: APPROVED_MODELS[0], policyVersion: 1, evaluator: APPROVED_MODELS[4] },
      inherited,
    ]) {
      const store = await fixture.storeWithReadyNode(fixture.dbName());
      const attemptId = deriveAttemptId('work-1', 'a', 1);
      const created = await store.createAttempt('work-1', 'a', attemptId, 1, deriveJobId(attemptId), routing as never);
      assert.ok('error' in created, 'routing must have exactly two own data properties');
      assert.equal(await store.getAttempt(attemptId), null);
      await store.close();
    }
  });
});

describe('dispatch wiring', () => {
  it('persists routing provenance resolved by the real router', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const result = await dispatchReadyFrontier(
      store,
      createQueue(),
      'work-1',
      'owner/repo',
      'main',
      new Map(),
      realResolver(),
    );
    assert.equal(result.dispatched.length, 1);
    const persisted = await store.getBuilderRoutingByAttemptId(result.dispatched[0]!.attempt_id);
    assert.notEqual(persisted, null, 'dispatch must persist the builder the router actually chose');
    await store.close();
  });

  it('returns a typed skipped outcome and persists nothing when the resolver throws', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const result = await dispatchReadyFrontier(
      store,
      createQueue(),
      'work-1',
      'owner/repo',
      'main',
      new Map(),
      async () => {
        throw new Error('availability unavailable');
      },
    );
    assert.equal(result.dispatched.length, 0);
    assert.deepEqual(result.skipped, [{ node_id: 'a', code: 'ROUTING_UNAVAILABLE' }]);
    assert.equal(await store.getAttempt(deriveAttemptId('work-1', 'a', 1)), null);
    await store.close();
  });

  it('returns a typed skipped outcome for invalid or unapproved builder routing', async () => {
    for (const routing of [
      { builder: 'openai-codex/not-approved', policyVersion: 1 },
      { builder: APPROVED_MODELS[0], policyVersion: 1, extra: true },
    ]) {
      const store = await fixture.storeWithReadyNode(fixture.dbName());
      const result = await dispatchReadyFrontier(
        store,
        createQueue(),
        'work-1',
        'owner/repo',
        'main',
        new Map(),
        async () => routing as never,
      );
      assert.equal(result.dispatched.length, 0);
      assert.deepEqual(result.skipped, [{ node_id: 'a', code: 'ROUTING_INVALID' }]);
      assert.equal(await store.getAttempt(deriveAttemptId('work-1', 'a', 1)), null);
      await store.close();
    }
  });

  it('returns a typed skipped outcome when the pending-to-ready transition fails', async () => {
    const failures: OrchestrationStore['transitionNode'][] = [
      async () => ({
        error: { code: 'STALE_VERSION' as const, message: 'intentionally hidden from dispatch result' },
      }),
      async () => {
        throw new Error('database unavailable');
      },
    ];

    for (const transitionNode of failures) {
      const store = await fixture.openStore(fixture.dbName());
      await store.importApprovedWork(approvedWork());
      const failingStore: OrchestrationStore = { ...store, transitionNode };
      const result = await dispatchReadyFrontier(
        failingStore,
        createQueue(),
        'work-1',
        'owner/repo',
        'main',
        new Map(),
        realResolver(),
      );
      assert.deepEqual(result.dispatched, []);
      assert.deepEqual(result.skipped, [{ node_id: 'a', code: 'NODE_TRANSITION_FAILED' }]);
      await store.close();
    }
  });

  it('returns a typed skipped outcome when attempt creation rejects valid routing', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const failingStore: OrchestrationStore = {
      ...store,
      createAttempt: async () => ({
        error: { code: 'INVALID_RESULT' as const, message: 'intentionally hidden from dispatch result' },
      }),
    };
    const result = await dispatchReadyFrontier(
      failingStore,
      createQueue(),
      'work-1',
      'owner/repo',
      'main',
      new Map(),
      realResolver(),
    );
    assert.equal(result.dispatched.length, 0);
    assert.deepEqual(result.skipped, [{ node_id: 'a', code: 'ATTEMPT_CREATION_FAILED' }]);
    assert.equal(await store.getAttempt(deriveAttemptId('work-1', 'a', 1)), null);
    await store.close();
  });

  it('returns a typed skipped outcome while retaining an attempt for reconciliation when enqueue fails', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const failingQueue: QueuePort = {
      async ensureJob() {
        throw new Error('queue unavailable');
      },
      async removeJob() {},
    };
    const result = await dispatchReadyFrontier(
      store,
      failingQueue,
      'work-1',
      'owner/repo',
      'main',
      new Map(),
      realResolver(),
    );
    assert.deepEqual(result.dispatched, []);
    assert.deepEqual(result.skipped, [{ node_id: 'a', code: 'QUEUE_ENQUEUE_FAILED' }]);
    assert.notEqual(
      await store.getAttempt(deriveAttemptId('work-1', 'a', 1)),
      null,
      'durable attempt remains for startup reconciliation',
    );
    await store.close();
  });
});
