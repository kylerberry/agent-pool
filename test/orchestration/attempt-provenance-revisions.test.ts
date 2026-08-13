import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { cleanRoot, createQueue, createStoreFixture, realResolver, tempRoot } from './attempt-provenance.fixtures.ts';

let root = '';
let fixture: ReturnType<typeof createStoreFixture>;
before(() => { root = tempRoot(); fixture = createStoreFixture(root); });
after(() => { cleanRoot(root); });

describe('phase_artifacts revision keying', () => {
  it('persists a needs_fix T and its subsequent passing T within one attempt', async () => {
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const attemptId = await fixture.makeAttempt(store);

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
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const attemptId = await fixture.makeAttempt(store);
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
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const attemptId = await fixture.makeAttempt(store);
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
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const attemptId = await fixture.makeAttempt(store);
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

describe('separate SQLite handles preserve phase-artifact conflict semantics', () => {
  it('rejects a duplicate (attempt_id, phase, revision) at the constraint', async () => {
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(store);
    const written = await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'passed',
      content_hash: '9'.repeat(64),
      artifact_path: 'phases/T.json',
    });
    assert.ok(!('error' in written));
    await store.close();

    // A second handle cannot insert a duplicate append-only revision.
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

  it('rejects a second handle’s ordered duplicate revision and preserves committed state', async () => {
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(store);
    await store.recordPhaseArtifact({
      attempt_id: attemptId,
      phase: 'T',
      status: 'needs_fix',
      content_hash: '1'.repeat(64),
      artifact_path: 'phases/T.json',
    });

    // This handle observes revision 1 before the store commits revision 2.
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
      'the ordered duplicate revision must be refused',
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

  it('fails closed and consumes no revision while another handle holds the lock', async () => {
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(store);
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
