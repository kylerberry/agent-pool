import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { cleanRoot, createQueue, createStoreFixture, realResolver, tempRoot } from './attempt-provenance.fixtures.ts';

let root = '';
let fixture: ReturnType<typeof createStoreFixture>;
before(() => { root = tempRoot(); fixture = createStoreFixture(root); });
after(() => { cleanRoot(root); });

describe('append-only enforcement', () => {
  it('aborts a direct UPDATE or DELETE against phase_artifacts', async () => {
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(store);
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
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(store);
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
    const reopened = await fixture.openStore(db);
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
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    await fixture.makeAttempt(store);
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
      const store = await fixture.storeWithReadyNode(fixture.dbName());
      const attemptId = await fixture.makeAttempt(store);
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
    const store = await fixture.storeWithReadyNode(fixture.dbName());
    const attemptId = await fixture.makeAttempt(store);
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
    const store = await fixture.storeWithReadyNode(fixture.dbName());
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
      const store = await fixture.storeWithReadyNode(fixture.dbName());
      const attemptId = await fixture.makeAttempt(store);
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
