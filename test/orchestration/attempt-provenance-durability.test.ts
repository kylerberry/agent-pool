import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { APPROVED_MODELS } from '../../src/domains/model-routing-and-evaluation/index.ts';
import { cleanRoot, createQueue, createStoreFixture, realResolver, tempRoot } from './attempt-provenance.fixtures.ts';

let root = '';
let fixture: ReturnType<typeof createStoreFixture>;
before(() => { root = tempRoot(); fixture = createStoreFixture(root); });
after(() => { cleanRoot(root); });

describe('durability across restart', () => {
  it('preserves both tables and revision ordering when reopened', async () => {
    const db = fixture.dbName();
    const first = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(first);
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

    const second = await fixture.openStore(db);
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
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(store);
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

    const reopened = await fixture.openStore(db);
    assert.equal((await reopened.listNodes('work-1')).length, 1, 'existing node rows survive the migration');
    assert.equal((await reopened.getAttempt(attemptId))?.attempt_id, attemptId, 'existing attempt rows survive the migration');
    assert.equal(await reopened.getBuilderRoutingByAttemptId(attemptId), null, 'v2 attempts do not gain fabricated provenance');
    await reopened.close();

    const migrated = new DatabaseSync(join(root, db));
    assert.equal((migrated.prepare('SELECT MAX(version) AS v FROM schema_version;').get() as { v: number }).v, 7);
    migrated.close();
  });

  it('migrates seeded v4 provenance without retaining evaluator inference', async () => {
    const db = fixture.dbName();
    const store = await fixture.storeWithReadyNode(db);
    const attemptId = await fixture.makeAttempt(store);
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

    const migrated = await fixture.openStore(db);
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
