import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqliteStore,
  deriveAttemptId,
  deriveJobId,
  dispatchReadyFrontier,
  type ApprovedWork,
  type QueuePort,
  type ResolvedBuilderRouting,
} from '../../src/domains/orchestration/index.ts';
import type { OrchestrationStore } from '../../src/domains/orchestration/sqlite-store.ts';
import {
  loadWorkerBootstrapPolicy,
  selectForRole,
  validateAvailability,
  isRoutingFailure,
  APPROVED_MODELS,
} from '../../src/domains/model-routing-and-evaluation/index.ts';

const workerFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../packages/worker-harness/config/model-routing.bootstrap.json'), 'utf8'),
);
const workerPolicy = loadWorkerBootstrapPolicy(workerFixture);

/**
 * The real builder router, wired the way a Pool Proof composition root would
 * wire it. It does not fabricate an evaluator before one has actually run.
 */
function realResolver(): (workId: string, nodeId: string, attemptId: string) => Promise<ResolvedBuilderRouting> {
  return async () => {
    const availability = validateAvailability(APPROVED_MODELS.map((fullId) => ({ fullId })));
    if (isRoutingFailure(availability)) throw new Error('availability snapshot invalid');
    const builder = selectForRole(workerPolicy, 'building', availability);
    if (isRoutingFailure(builder)) throw new Error(`routing failed: ${builder.code}`);
    return {
      builder: builder.selectedModel,
      policyVersion: builder.policyVersion,
    };
  };
}

let root = '';
let storeCounter = 0;

function node(id: string, dependsOn: readonly string[] = []) {
  return {
    id,
    intent: `intent ${id}`,
    change_spec: `spec ${id}`,
    acceptance_criteria: [`criterion ${id}`],
    depends_on: [...dependsOn],
    criteria_origin_source: 'direct_task',
    criteria_origin_source_id: 'sub-1',
  };
}

function approvedWork(): ApprovedWork {
  return {
    work_id: 'work-1',
    origin: 'direct_task',
    repo: 'owner/repo',
    branch: 'main',
    payload_hash: 'hash-1',
    nodes: [node('a')],
  } as unknown as ApprovedWork;
}

function dbName(): string {
  return `provenance-${++storeCounter}.db`;
}

async function openStore(db: string): Promise<OrchestrationStore> {
  return createSqliteStore({ runtimeRoot: root, dbLocation: db });
}

async function storeWithReadyNode(db: string) {
  const store = await openStore(db);
  const imported = await store.importApprovedWork(approvedWork());
  if ('error' in imported) throw new Error(`import failed: ${JSON.stringify(imported.error)}`);
  const nodes = await store.listNodes('work-1');
  const record = nodes.find((n) => n.node_id === 'a')!;
  if (record.state === 'pending') {
    const t = await store.transitionNode('work-1', 'a', record.version, 'ready');
    if ('error' in t) throw new Error(String(t.error));
  }
  return store;
}

async function makeAttempt(
  store: OrchestrationStore,
  builderRouting: ResolvedBuilderRouting = { builder: APPROVED_MODELS[0], policyVersion: 1 },
) {
  const attemptId = deriveAttemptId('work-1', 'a', 1);
  const created = await store.createAttempt('work-1', 'a', attemptId, 1, deriveJobId(attemptId), builderRouting);
  if ('error' in created) throw new Error(`createAttempt failed: ${JSON.stringify(created.error)}`);
  return attemptId;
}

function createQueue(): QueuePort {
  return {
    async ensureJob() {},
    async removeJob() {},
  } as unknown as QueuePort;
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'provenance-test-')));
});

after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

describe('phase_artifacts revision keying', () => {
  it('persists a needs_fix T and its subsequent passing T within one attempt', async () => {
    const store = await storeWithReadyNode(dbName());
    const attemptId = await makeAttempt(store);

    const first = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'needs_fix',
      content_hash: 'a'.repeat(64),
      artifact_path: 'phases/T.json',
    });
    const second = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: 'b'.repeat(64),
      artifact_path: 'phases/T-2.json',
    });

    assert.ok(!('error' in first), `first insert failed: ${JSON.stringify(first)}`);
    assert.ok(!('error' in second), `second insert failed: ${JSON.stringify(second)}`);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);

    const history = await store.getPhaseArtifactRevisions(attemptId, 'T');
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((r) => [r.revision, r.status]),
      [
        [1, 'needs_fix'],
        [2, 'passed'],
      ],
    );
    await store.close();
  });

  it('resolves the latest revision by default', async () => {
    const store = await storeWithReadyNode(dbName());
    const attemptId = await makeAttempt(store);
    for (const [i, status] of ['needs_fix', 'needs_fix', 'passed'].entries()) {
      await store.recordPhaseArtifact({
        attempt_id: attemptId,
        phase: 'F',
        status,
        content_hash: String(i).repeat(64),
        artifact_path: `phases/F-${i}.json`,
      });
    }
    const latest = await store.getLatestPhaseArtifact(attemptId, 'F');
    assert.equal(latest?.revision, 3);
    assert.equal(latest?.status, 'passed');
    assert.equal(await store.getLatestPhaseArtifact(attemptId, 'S'), null);
    await store.close();
  });

  it('assigns revision itself and ignores any caller-supplied value', async () => {
    const store = await storeWithReadyNode(dbName());
    const attemptId = await makeAttempt(store);
    const written = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'C',
      status: 'passed',
      content_hash: 'c'.repeat(64),
      artifact_path: 'phases/C.json',
      revision: 99,
    } as never);
    assert.ok(!('error' in written));
    assert.equal(written.revision, 1);
    await store.close();
  });

  it('allocates distinct sequential revisions across successive inserts', async () => {
    const store = await storeWithReadyNode(dbName());
    const attemptId = await makeAttempt(store);
    const results = [];
    for (const i of [0, 1, 2, 3]) {
      results.push(
        await store.recordPhaseArtifact({
          attempt_id: attemptId,
          phase: 'R',
          status: 'passed',
          content_hash: String(i).repeat(64),
          artifact_path: `phases/R-${i}.json`,
        }),
      );
    }
    for (const r of results) assert.ok(!('error' in r), `insert failed: ${JSON.stringify(r)}`);
    const revisions = results.map((r) => (r as { revision: number }).revision);
    assert.deepEqual(revisions, [1, 2, 3, 4], 'revisions must be unique, sequential, and gapless');
    await store.close();
  });
});

/**
 * These replace an earlier Promise.all test that could not fail: recordPhaseArtifact
 * contains no await and node:sqlite is synchronous, so those inserts serialized and
 * the assertion held regardless of BEGIN IMMEDIATE, the RESERVED lock, or the UNIQUE
 * constraint. Each test below constrains a distinct part of the mechanism.
 */
describe('revision allocation under write contention', () => {
  it('rejects a duplicate (attempt_id, phase, revision) at the constraint', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(store);
    const written = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '9'.repeat(64),
      artifact_path: 'phases/T.json',
    });
    assert.ok(!('error' in written));
    await store.close();

    // The backstop that turns a lost allocation race into a rollback rather
    // than a duplicate. Nothing else in the suite exercises it.
    const raw = new DatabaseSync(join(root, db));
    assert.throws(
      () =>
        raw
          .prepare('INSERT INTO phase_artifacts (attempt_id, phase, revision, status, content_hash, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);')
          .run(attemptId, 'T', written.revision, 'passed', '8'.repeat(64), 'phases/T-dup.json', new Date().toISOString()),
      /append-only|UNIQUE constraint failed/,
    );
    raw.close();
  });

  it('allocates from the committed maximum, not from a previously observed one', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(store);
    await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'needs_fix',
      content_hash: '1'.repeat(64),
      artifact_path: 'phases/T.json',
    });

    // Stand in for a second writer that read the maximum and then lost the race.
    // A read-modify-write implementation would reuse this value; allocation
    // inside the INSERT cannot, because it never leaves the statement.
    const observer = new DatabaseSync(join(root, db));
    const staleMax = (
      observer
        .prepare('SELECT COALESCE(MAX(revision), 0) AS m FROM phase_artifacts WHERE attempt_id = ? AND phase = ?')
        .get(attemptId, 'T') as { m: number }
    ).m;

    const second = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '2'.repeat(64),
      artifact_path: 'phases/T-2.json',
    });
    assert.ok(!('error' in second));

    assert.throws(
      () =>
        observer
          .prepare('INSERT INTO phase_artifacts (attempt_id, phase, revision, status, content_hash, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);')
          .run(attemptId, 'T', staleMax + 1, 'passed', '3'.repeat(64), 'phases/stale.json', new Date().toISOString()),
      /append-only|UNIQUE constraint failed/,
      'the stale allocation must be refused rather than duplicating a revision',
    );
    observer.close();

    const third = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '4'.repeat(64),
      artifact_path: 'phases/T-3.json',
    });
    assert.ok(!('error' in third));
    assert.equal(third.revision, 3, 'allocation must advance past the committed maximum');
    await store.close();
  });

  it('fails closed and consumes no revision when another writer holds the lock', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(store);
    await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'needs_fix',
      content_hash: '1'.repeat(64),
      artifact_path: 'phases/T.json',
    });

    // Hold the write lock from a second connection. With no busy_timeout the
    // store's own BEGIN IMMEDIATE is refused rather than queued.
    const blocker = new DatabaseSync(join(root, db));
    blocker.exec('BEGIN IMMEDIATE;');

    const blocked = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '2'.repeat(64),
      artifact_path: 'phases/T-2.json',
    });
    assert.ok('error' in blocked, 'a blocked write must fail closed, not allocate optimistically');

    blocker.exec('ROLLBACK;');
    blocker.close();

    // The rejected attempt must not have burned revision 2, or history would
    // carry a gap that later readers cannot distinguish from a lost artifact.
    const after = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '3'.repeat(64),
      artifact_path: 'phases/T-3.json',
    });
    assert.ok(!('error' in after), `insert after contention failed: ${JSON.stringify(after)}`);
    assert.equal(after.revision, 2, 'a failed insert must consume no revision');
    assert.deepEqual((await store.getPhaseArtifactRevisions(attemptId, 'T')).map((r) => r.revision), [1, 2]);
    await store.close();
  });
});

describe('append-only enforcement', () => {
  it('aborts a direct UPDATE or DELETE against phase_artifacts', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(store);
    await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'needs_fix',
      content_hash: 'd'.repeat(64),
      artifact_path: 'phases/T.json',
    });
    await store.close();

    const raw = new DatabaseSync(join(root, db));
    assert.throws(() => raw.prepare("UPDATE phase_artifacts SET status = 'passed';").run());
    assert.throws(() => raw.prepare('DELETE FROM phase_artifacts;').run());
    const rows = raw.prepare('SELECT status FROM phase_artifacts;').all() as { status: string }[];
    assert.deepEqual(rows.map((r) => r.status), ['needs_fix']);
    raw.close();
  });

  it('aborts INSERT OR REPLACE, which bypasses the triggers by default', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(store);
    await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'needs_fix',
      content_hash: '7'.repeat(64),
      artifact_path: 'phases/T.json',
    });
    await store.close();

    // REPLACE deletes the conflicting row, and with SQLite's default
    // recursive_triggers = OFF that delete does not fire BEFORE DELETE. Without
    // the store's PRAGMA this rewrites a needs_fix grading outcome to passed
    // while the table still looks append-only.
    const reopened = await openStore(db);
    // Deliberately a default-pragma connection: recursive_triggers is
    // per-connection, so the guarantee must not depend on the writer's settings.
    const raw = new DatabaseSync(join(root, db));
    assert.throws(
      () =>
        raw
          .prepare('INSERT OR REPLACE INTO phase_artifacts (attempt_id, phase, revision, status, content_hash, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);')
          .run(attemptId, 'T', 1, 'passed', '6'.repeat(64), 'phases/T.json', new Date().toISOString()),
      /append-only/,
    );
    raw.close();

    const history = await reopened.getPhaseArtifactRevisions(attemptId, 'T');
    assert.deepEqual(history.map((r) => r.status), ['needs_fix'], 'the recorded outcome must survive a REPLACE attempt');
    await reopened.close();
  });

  it('aborts a direct UPDATE or DELETE against attempt_routing_decisions', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    await makeAttempt(store);
    await store.close();

    const raw = new DatabaseSync(join(root, db));
    assert.throws(() => raw.prepare("UPDATE attempt_routing_decisions SET builder_model = 'x';").run());
    assert.throws(() => raw.prepare('DELETE FROM attempt_routing_decisions;').run());
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM attempt_routing_decisions;').get() as { n: number }).n, 1);
    raw.close();
  });
});

describe('artifact_path locator validation', () => {
  const rejected: readonly [string, string][] = [
    ['absolute path', '/etc/passwd'],
    ['parent segment', '../../.ssh/id_ed25519'],
    ['backslash parent segment', '..\\..\\escape.json'],
    ['nested parent segment', 'phases/../../escape.json'],
    ['nul byte', 'phases/T\u0000.json'],
    ['empty', ''],
  ];

  for (const [label, path] of rejected) {
    it(`rejects ${label}`, async () => {
      const store = await storeWithReadyNode(dbName());
      const attemptId = await makeAttempt(store);
      const result = await store.recordPhaseArtifact({
        attempt_id: attemptId,
        phase: 'T',
        status: 'passed',
        content_hash: 'e'.repeat(64),
        artifact_path: path,
      });
      assert.ok('error' in result, `expected rejection for ${label}`);
      assert.equal((await store.getPhaseArtifactRevisions(attemptId, 'T')).length, 0);
      await store.close();
    });
  }

  it('accepts a workspace-relative locator', async () => {
    const store = await storeWithReadyNode(dbName());
    const attemptId = await makeAttempt(store);
    const result = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: 'f'.repeat(64),
      artifact_path: 'phases/attempt/T.json',
    });
    assert.ok(!('error' in result));
    await store.close();
  });

  it('rejects an artifact for an unknown attempt through the database constraint', async () => {
    const store = await storeWithReadyNode(dbName());
    const result = await store.recordPhaseArtifact({
      attempt_id: 'att://work-1/missing/1',
      phase: 'T',
      status: 'passed',
      content_hash: 'a'.repeat(64),
      artifact_path: 'phases/T.json',
    });
    assert.ok('error' in result);
    await store.close();
  });

  for (const [field, value] of [
    ['phase', 'Z'],
    ['status', 'pending'],
  ] as const) {
    it(`rejects unsupported artifact ${field}`, async () => {
      const store = await storeWithReadyNode(dbName());
      const attemptId = await makeAttempt(store);
      const result = await store.recordPhaseArtifact({
        attempt_id: attemptId,
        phase: field === 'phase' ? value : 'T',
        status: field === 'status' ? value : 'passed',
        content_hash: 'a'.repeat(64),
        artifact_path: 'phases/T.json',
      });
      assert.ok('error' in result);
      await store.close();
    });
  }
});

describe('attempt builder routing provenance', () => {
  it('persists the canonical builder selected at dispatch', async () => {
    const store = await storeWithReadyNode(dbName());
    const attemptId = await makeAttempt(store, {
      builder: APPROVED_MODELS[0],
      policyVersion: 1,
    });
    const persisted = await store.getBuilderRoutingByAttemptId(attemptId);
    assert.equal(persisted?.builder_model, APPROVED_MODELS[0]);
    assert.equal(persisted?.policy_version, 1);
    await store.close();
  });

  it('returns null for an attempt that was never created', async () => {
    const store = await storeWithReadyNode(dbName());
    assert.equal(await store.getBuilderRoutingByAttemptId('att://work-1/missing/1'), null);
    await store.close();
  });

  it('rolls back the whole attempt when builder routing is outside the canonical registry', async () => {
    const store = await storeWithReadyNode(dbName());
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
      const store = await storeWithReadyNode(dbName());
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
    const store = await storeWithReadyNode(dbName());
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
    const store = await storeWithReadyNode(dbName());
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
      const store = await storeWithReadyNode(dbName());
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
      const store = await openStore(dbName());
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
    const store = await storeWithReadyNode(dbName());
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
    const store = await storeWithReadyNode(dbName());
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

describe('durability across restart', () => {
  it('preserves both tables and revision ordering when reopened', async () => {
    const db = dbName();
    const first = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(first);
    await first.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'needs_fix',
      content_hash: '1'.repeat(64),
      artifact_path: 'phases/T.json',
    });
    await first.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '2'.repeat(64),
      artifact_path: 'phases/T-2.json',
    });
    await first.close();

    const second = await openStore(db);
    const history = await second.getPhaseArtifactRevisions(attemptId, 'T');
    assert.deepEqual(history.map((r) => r.revision), [1, 2]);
    assert.equal(history[1]!.status, 'passed');
    assert.notEqual(await second.getBuilderRoutingByAttemptId(attemptId), null);

    const next = await second.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '3'.repeat(64),
      artifact_path: 'phases/T-3.json',
    });
    assert.ok(!('error' in next));
    assert.equal(next.revision, 3, 'revision allocation must continue across restart');
    await second.close();
  });

  it('migrates a representative pre-provenance v2 database without data loss', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(store);
    await store.close();

    // Construct an on-disk v2 fixture with real work, node, and attempt rows.
    // Provenance tables and their migration markers did not exist at v2.
    const raw = new DatabaseSync(join(root, db));
    raw.exec(`
      DROP TRIGGER IF EXISTS trg_phase_artifacts_no_update;
      DROP TRIGGER IF EXISTS trg_phase_artifacts_no_delete;
      DROP TRIGGER IF EXISTS trg_phase_artifacts_no_replace;
      DROP TRIGGER IF EXISTS trg_attempt_routing_no_update;
      DROP TRIGGER IF EXISTS trg_attempt_routing_no_delete;
      DROP TRIGGER IF EXISTS trg_attempt_routing_no_replace;
      DROP TABLE phase_artifacts;
      DROP TABLE attempt_routing_decisions;
      DELETE FROM schema_version WHERE version > 2;
    `);
    assert.equal((raw.prepare('SELECT MAX(version) AS v FROM schema_version;').get() as { v: number }).v, 2);
    raw.close();

    const reopened = await openStore(db);
    assert.equal((await reopened.listNodes('work-1')).length, 1, 'existing node rows survive the migration');
    assert.equal((await reopened.getAttempt(attemptId))?.attempt_id, attemptId, 'existing attempt rows survive the migration');
    assert.equal(await reopened.getBuilderRoutingByAttemptId(attemptId), null, 'v2 attempts do not gain fabricated provenance');
    await reopened.close();

    const migrated = new DatabaseSync(join(root, db));
    assert.equal((migrated.prepare('SELECT MAX(version) AS v FROM schema_version;').get() as { v: number }).v, 7);
    migrated.close();
  });

  it('migrates seeded v4 provenance without retaining evaluator inference', async () => {
    const db = dbName();
    const store = await storeWithReadyNode(db);
    const attemptId = await makeAttempt(store);
    for (const [status, path, hash] of [
      ['needs_fix', 'phases/T.json', '1'.repeat(64)],
      ['passed', 'phases/T-2.json', '2'.repeat(64)],
    ] as const) {
      const recorded = await store.recordPhaseArtifact({
        attempt_id: attemptId,
        phase: 'T',
        status,
        content_hash: hash,
        artifact_path: path,
      });
      assert.ok(!('error' in recorded));
    }
    await store.close();

    // Rebuild only the provenance tables into their v4 form and seed a real
    // evaluator value. The v5 migration must retain builder and artifact
    // history while intentionally discarding that pre-invocation evaluator.
    const raw = new DatabaseSync(join(root, db));
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER IF EXISTS trg_phase_artifacts_no_update;
      DROP TRIGGER IF EXISTS trg_phase_artifacts_no_delete;
      DROP TRIGGER IF EXISTS trg_phase_artifacts_no_replace;
      DROP TRIGGER IF EXISTS trg_attempt_routing_no_update;
      DROP TRIGGER IF EXISTS trg_attempt_routing_no_delete;
      DROP TRIGGER IF EXISTS trg_attempt_routing_no_replace;
      DROP INDEX IF EXISTS idx_phase_artifacts_attempt;
      ALTER TABLE attempt_routing_decisions RENAME TO attempt_routing_decisions_v5;
      ALTER TABLE phase_artifacts RENAME TO phase_artifacts_v5;
      CREATE TABLE attempt_routing_decisions (
        attempt_id TEXT PRIMARY KEY,
        builder_model TEXT NOT NULL,
        evaluator_model TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE phase_artifacts (
        attempt_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (attempt_id, phase, revision)
      );
      INSERT INTO attempt_routing_decisions (attempt_id, builder_model, evaluator_model, policy_version, created_at)
      SELECT attempt_id, builder_model, 'openai-codex/gpt-5.6-sol', policy_version, created_at
      FROM attempt_routing_decisions_v5;
      INSERT INTO phase_artifacts (attempt_id, phase, revision, status, content_hash, artifact_path, created_at)
      SELECT attempt_id, phase, revision, status, content_hash, artifact_path, created_at
      FROM phase_artifacts_v5;
      DROP TABLE attempt_routing_decisions_v5;
      DROP TABLE phase_artifacts_v5;
      CREATE INDEX idx_phase_artifacts_attempt ON phase_artifacts(attempt_id, phase, revision);
      CREATE TRIGGER trg_phase_artifacts_no_update BEFORE UPDATE ON phase_artifacts
      BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;
      CREATE TRIGGER trg_phase_artifacts_no_delete BEFORE DELETE ON phase_artifacts
      BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;
      CREATE TRIGGER trg_phase_artifacts_no_replace BEFORE INSERT ON phase_artifacts
      WHEN EXISTS (SELECT 1 FROM phase_artifacts WHERE attempt_id = NEW.attempt_id AND phase = NEW.phase AND revision = NEW.revision)
      BEGIN SELECT RAISE(ABORT, 'phase_artifacts is append-only'); END;
      CREATE TRIGGER trg_attempt_routing_no_update BEFORE UPDATE ON attempt_routing_decisions
      BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;
      CREATE TRIGGER trg_attempt_routing_no_delete BEFORE DELETE ON attempt_routing_decisions
      BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;
      CREATE TRIGGER trg_attempt_routing_no_replace BEFORE INSERT ON attempt_routing_decisions
      WHEN EXISTS (SELECT 1 FROM attempt_routing_decisions WHERE attempt_id = NEW.attempt_id)
      BEGIN SELECT RAISE(ABORT, 'attempt_routing_decisions is append-only'); END;
      DELETE FROM schema_version WHERE version > 4;
      PRAGMA foreign_keys = ON;
    `);
    assert.equal((raw.prepare('SELECT MAX(version) AS v FROM schema_version;').get() as { v: number }).v, 4);
    raw.close();

    const migrated = await openStore(db);
    const builderRouting = await migrated.getBuilderRoutingByAttemptId(attemptId);
    assert.equal(builderRouting?.attempt_id, attemptId);
    assert.equal(builderRouting?.builder_model, APPROVED_MODELS[0]);
    assert.equal(builderRouting?.policy_version, 1);
    assert.deepEqual(
      (await migrated.getPhaseArtifactRevisions(attemptId, 'T')).map((artifact) => [artifact.revision, artifact.status]),
      [[1, 'needs_fix'], [2, 'passed']],
    );
    const rejected = await migrated.recordPhaseArtifact({
      attempt_id: 'att://work-1/missing/1',
      phase: 'T',
      status: 'passed',
      content_hash: '3'.repeat(64),
      artifact_path: 'phases/missing.json',
    });
    assert.ok('error' in rejected, 'v5 phase artifacts enforce the attempt foreign key');
    await migrated.close();

    const verified = new DatabaseSync(join(root, db));
    const columns = verified.prepare('PRAGMA table_info(attempt_routing_decisions)').all() as { name: string }[];
    assert.equal(columns.some((column) => column.name === 'evaluator_model'), false);
    assert.throws(() => verified.prepare("UPDATE phase_artifacts SET status = 'passed';").run(), /append-only/);
    assert.throws(
      () => verified.prepare('INSERT OR REPLACE INTO phase_artifacts (attempt_id, phase, revision, status, content_hash, artifact_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);').run(
        attemptId, 'T', 1, 'passed', '4'.repeat(64), 'phases/T.json', new Date().toISOString(),
      ),
      /append-only/,
    );
    verified.close();
  });
});
