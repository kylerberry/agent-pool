import type { ApprovedNode, QueueEnvelope } from './contracts.ts';
import { computeReadyFrontier } from './ready-frontier.ts';
import {
  deriveAttemptId,
  deriveJobId,
  makeQueueEnvelope,
  projectAttemptContract,
} from './attempt-dispatch.ts';
import type { OrchestrationStore } from './sqlite-store.ts';

export { consumeQueueEnvelope } from './attempt-dispatch.ts';

/**
 * Application service: compute the ready frontier for a work item and ensure
 * one deterministic attempt/job per selectable node.
 *
 * The queue envelope contains identifiers only; all immutable content lives in
 * SQLite and is rehydrated on consumption.
 */
export async function dispatchReadyFrontier(
  store: OrchestrationStore,
  queue: { readonly ensureJob: (envelope: QueueEnvelope) => Promise<void> },
  workId: string,
  repo: string,
  branch: string,
  schedulingBlockers: ReadonlyMap<string, string>,
): Promise<{ readonly dispatched: readonly { readonly attempt_id: string; readonly job_id: string }[] }> {
  const work = await store.getImportedWork(workId);
  if (!work) {
    throw new Error(`work ${workId} not found`);
  }

  const nodeRecords = await store.listNodes(workId);
  const approvedNodes: ApprovedNode[] = [];
  for (const record of nodeRecords) {
    const node = await store.getApprovedNode(workId, record.node_id);
    if (node) approvedNodes.push(node);
  }

  const passedIds = new Set(nodeRecords.filter((n) => n.state === 'passed').map((n) => n.node_id));

  const frontier = computeReadyFrontier(approvedNodes, passedIds, schedulingBlockers);

  const dispatched: { attempt_id: string; job_id: string }[] = [];
  for (const entry of frontier) {
    if (!entry.ready_after_scheduling) continue;

    const record = nodeRecords.find((n) => n.node_id === entry.node.id);
    if (!record) continue;

    let nodeVersion = record.version;
    let nodeState = record.state;
    if (record.state === 'pending') {
      const transitioned = await store.transitionNode(workId, entry.node.id, record.version, 'ready');
      if ('error' in transitioned) {
        continue;
      }
      nodeVersion = transitioned.version;
      nodeState = transitioned.state;
    }
    if (nodeState !== 'ready') {
      continue;
    }

    const attemptNumber = 1;
    const attemptId = deriveAttemptId(workId, entry.node.id, attemptNumber);
    const jobId = deriveJobId(attemptId);

    const attempt = await store.createAttempt(workId, entry.node.id, attemptId, attemptNumber, jobId);
    if ('error' in attempt) {
      continue;
    }

    await queue.ensureJob(makeQueueEnvelope(workId, entry.node.id, attemptNumber));
    dispatched.push({ attempt_id: attemptId, job_id: jobId });
  }

  return { dispatched };
}
