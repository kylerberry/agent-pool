import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteStore, deriveAttemptId, deriveJobId, makeEmpiricalSchedulingPolicy,
  type ApprovedNode, type ApprovedWork, type PredictedTouchEvidence, type QueuePort,
  type ResolvedBuilderRouting, type SchedulingPolicy, type WorkerResult,
} from '../../src/domains/orchestration/index.ts';
import type { OrchestrationStore } from '../../src/domains/orchestration/sqlite-store.ts';

export function tempRoot(): string { return realpathSync(mkdtempSync(join(tmpdir(), 'orch-test-'))); }
export function cleanRoot(dir: string): void { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

export function createQueue(): QueuePort & { readonly jobs: Map<string, { jobId: string; attemptId: string; nodeId: string; workId: string }>; readonly removed: Set<string> } {
  const jobs = new Map<string, { jobId: string; attemptId: string; nodeId: string; workId: string }>();
  const removed = new Set<string>();
  return {
    jobs, removed,
    async ensureJob(envelope) { jobs.set(envelope.job_id, { jobId: envelope.job_id, attemptId: envelope.attempt_id, nodeId: envelope.node_id, workId: envelope.work_id }); },
    async removeJob(jobId) { removed.add(jobId); jobs.delete(jobId); },
  };
}

export function node(id: string, deps: readonly string[] = [], overrides: Partial<ApprovedNode> = {}): ApprovedNode {
  return { id, intent: `intent ${id}`, change_spec: `change ${id}`, acceptance_criteria: [`${id} criterion`], depends_on: deps, criteria_origin_source: 'direct_task', criteria_origin_source_id: 'sub-1', ...overrides };
}

export function approvedWork(overrides: Partial<ApprovedWork> & { nodes?: ApprovedNode[] } = {}): ApprovedWork {
  return { work_id: 'work-1', origin: 'direct_task', repo: 'owner/repo', branch: 'main', payload_hash: 'hash-1', nodes: [node('a'), node('b', ['a'])], ...overrides };
}

let storeCounter = 0;
export async function openStore(root: string, db?: string, backupHook?: () => Promise<void>) {
  return createSqliteStore({ runtimeRoot: root, dbLocation: db ?? `orchestration-${++storeCounter}.db`, backupHook });
}
export async function openStoreWithWork(root: string, work: ApprovedWork = approvedWork()) {
  const store = await openStore(root);
  const imported = await store.importApprovedWork(work);
  if ('error' in imported) throw new Error(`import failed: ${JSON.stringify(imported.error)}`);
  return store;
}
export async function readyNode(store: OrchestrationStore, workId: string, nodeId: string) {
  const record = (await store.listNodes(workId)).find((n) => n.node_id === nodeId);
  if (!record) throw new Error(`readyNode: node ${nodeId} not found in work ${workId}`);
  if (record.state === 'pending') {
    const transitioned = await store.transitionNode(workId, nodeId, record.version, 'ready');
    if ('error' in transitioned) throw new Error(String(transitioned.error));
  }
}
export function testBuilderRouting(): ResolvedBuilderRouting { return { builder: 'openai-codex/gpt-5.6-luna', policyVersion: 1 }; }
export const testBuilderRoutingResolver = async () => testBuilderRouting();
export async function createReadyAttempt(store: OrchestrationStore, workId: string, nodeId: string, attemptNumber = 1) {
  await readyNode(store, workId, nodeId);
  const attemptId = deriveAttemptId(workId, nodeId, attemptNumber);
  const jobId = deriveJobId(attemptId);
  const attempt = await store.createAttempt(workId, nodeId, attemptId, attemptNumber, jobId, testBuilderRouting());
  if ('error' in attempt) throw new Error(`createAttempt error: ${JSON.stringify(attempt.error)}`);
  return { attemptId, jobId };
}
export function makeResult(opts: Partial<WorkerResult> & { attempt_id: string; node_id: string; work_id: string; token: string; generation: number; expected_node_version: number }): WorkerResult {
  return { result_id: 'res-1', phase: 'R', outcome: 'passed', artifact_path: undefined, summary: undefined, ...opts };
}
export function policy(version = 'policy-1', minConfidence = 0.7): SchedulingPolicy { return makeEmpiricalSchedulingPolicy({ version, minConfidence }); }
export function evidence(overrides: Partial<PredictedTouchEvidence> = {}): PredictedTouchEvidence {
  return { evidence_id: 'ev-1', repo: 'owner/repo', approved_head: 'head-1', graph_revision: 'graph-1', manifest_digest: 'manifest-1', algorithm_version: 'alg-1', policy_version: 'policy-1', gate1_approval_id: 'gate1-1', classified_overlaps: [{ node_id: 'b', confidence: 0.9, likely_touched_units: ['unit-1'], shared_surfaces: ['s-1'] }], ...overrides };
}
export async function withPrototypePollution<T>(pollutants: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(pollutants)) { originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key)); Object.defineProperty(Object.prototype, key, { value: pollutants[key], configurable: true, writable: true, enumerable: true }); }
  try { return await fn(); } finally { for (const [key, descriptor] of originals) { if (descriptor === undefined) delete (Object.prototype as Record<string, unknown>)[key]; else Object.defineProperty(Object.prototype, key, descriptor); } }
}
