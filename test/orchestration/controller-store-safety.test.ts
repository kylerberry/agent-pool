import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteStore, deriveAttemptId, deriveJobId, reconcile } from '../../src/domains/orchestration/index.ts';
import { cleanRoot, createQueue, createReadyAttempt, node, openStore, openStoreWithWork, makeResult, readyNode, tempRoot, testBuilderRouting } from './controller-ready-frontier.fixtures.ts';

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
    await store.createAttempt('work-1', 'a', attemptId, 1, jobId, testBuilderRouting());
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
    assert.equal(getSchemaVersion(path), 7);
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
    assert.equal(getSchemaVersion(path), 7);
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
