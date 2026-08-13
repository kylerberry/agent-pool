import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSqliteStore,
  deriveAttemptId,
  deriveJobId,
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

/** The real builder router as wired by a Pool Proof composition root. */
export function realResolver(): (workId: string, nodeId: string, attemptId: string) => Promise<ResolvedBuilderRouting> {
  return async () => {
    const availability = validateAvailability(APPROVED_MODELS.map((fullId) => ({ fullId })));
    if (isRoutingFailure(availability)) throw new Error('availability snapshot invalid');
    const builder = selectForRole(workerPolicy, 'building', availability);
    if (isRoutingFailure(builder)) throw new Error(`routing failed: ${builder.code}`);
    return { builder: builder.selectedModel, policyVersion: builder.policyVersion };
  };
}

export function tempRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'provenance-test-')));
}

export function cleanRoot(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

export function node(id: string, dependsOn: readonly string[] = []) {
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

export function approvedWork(): ApprovedWork {
  return {
    work_id: 'work-1', origin: 'direct_task', repo: 'owner/repo', branch: 'main', payload_hash: 'hash-1', nodes: [node('a')],
  } as unknown as ApprovedWork;
}

export function createStoreFixture(root: string) {
  let storeCounter = 0;
  const dbName = () => `provenance-${++storeCounter}.db`;
  const openStore = async (db: string): Promise<OrchestrationStore> => createSqliteStore({ runtimeRoot: root, dbLocation: db });
  const storeWithReadyNode = async (db: string) => {
    const store = await openStore(db);
    const imported = await store.importApprovedWork(approvedWork());
    if ('error' in imported) throw new Error(`import failed: ${JSON.stringify(imported.error)}`);
    const record = (await store.listNodes('work-1')).find((n) => n.node_id === 'a')!;
    if (record.state === 'pending') {
      const transitioned = await store.transitionNode('work-1', 'a', record.version, 'ready');
      if ('error' in transitioned) throw new Error(String(transitioned.error));
    }
    return store;
  };
  const makeAttempt = async (store: OrchestrationStore, builderRouting: ResolvedBuilderRouting = { builder: APPROVED_MODELS[0], policyVersion: 1 }) => {
    const attemptId = deriveAttemptId('work-1', 'a', 1);
    const created = await store.createAttempt('work-1', 'a', attemptId, 1, deriveJobId(attemptId), builderRouting);
    if ('error' in created) throw new Error(`createAttempt failed: ${JSON.stringify(created.error)}`);
    return attemptId;
  };
  return { dbName, openStore, storeWithReadyNode, makeAttempt };
}

export function createQueue(): QueuePort {
  return { async ensureJob() {}, async removeJob() {} } as unknown as QueuePort;
}
