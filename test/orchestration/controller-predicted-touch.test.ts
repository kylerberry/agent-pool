import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { type PredictedTouchEvidence, type PredictedTouchImport } from '../../src/domains/orchestration/index.ts';
import { cleanRoot, evidence, node, openStore, approvedWork, policy, tempRoot, withPrototypePollution } from './controller-ready-frontier.fixtures.ts';

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
