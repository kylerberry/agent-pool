import {
  isResolvedBuilderRouting,
  type ApprovedNode,
  type QueueEnvelope,
  type ResolvedBuilderRouting,
} from './contracts.ts';
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
 * Supplied by the composition root that owns the validated availability
 * snapshot. Making this a required parameter rather than an Orchestration-side
 * import of Model Routing keeps the domain boundary intact and turns a missing
 * wiring into an explicit dispatch outcome instead of a runtime default.
 */
export type BuilderRoutingResolver = (
  workId: string,
  nodeId: string,
  attemptId: string,
) => Promise<ResolvedBuilderRouting>;

export type DispatchSkippedNode = {
  readonly node_id: string;
  readonly code:
    | 'NODE_RECORD_MISSING'
    | 'NODE_TRANSITION_FAILED'
    | 'NODE_NOT_DISPATCHABLE'
    | 'ROUTING_UNAVAILABLE'
    | 'ROUTING_INVALID'
    | 'ATTEMPT_CREATION_FAILED'
    | 'QUEUE_ENQUEUE_FAILED';
};

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
  resolveBuilderRouting: BuilderRoutingResolver,
): Promise<{
  readonly dispatched: readonly { readonly attempt_id: string; readonly job_id: string }[];
  readonly skipped: readonly DispatchSkippedNode[];
}> {
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
  const skipped: DispatchSkippedNode[] = [];
  for (const entry of frontier) {
    if (!entry.ready_after_scheduling) continue;

    const record = nodeRecords.find((n) => n.node_id === entry.node.id);
    if (!record) {
      skipped.push({ node_id: entry.node.id, code: 'NODE_RECORD_MISSING' });
      continue;
    }

    let nodeState = record.state;
    if (record.state === 'pending') {
      try {
        const transitioned = await store.transitionNode(workId, entry.node.id, record.version, 'ready');
        if ('error' in transitioned) {
          skipped.push({ node_id: entry.node.id, code: 'NODE_TRANSITION_FAILED' });
          continue;
        }
        nodeState = transitioned.state;
      } catch {
        skipped.push({ node_id: entry.node.id, code: 'NODE_TRANSITION_FAILED' });
        continue;
      }
    }
    if (nodeState !== 'ready') {
      skipped.push({ node_id: entry.node.id, code: 'NODE_NOT_DISPATCHABLE' });
      continue;
    }

    const attemptNumber = 1;
    const attemptId = deriveAttemptId(workId, entry.node.id, attemptNumber);
    const jobId = deriveJobId(attemptId);

    // Do not dispatch an attempt without a verified builder selection. Resolver
    // failures and malformed results are distinct, typed outcomes so a caller
    // never mistakes either for an empty frontier.
    let builderRouting: ResolvedBuilderRouting;
    try {
      builderRouting = await resolveBuilderRouting(workId, entry.node.id, attemptId);
    } catch {
      skipped.push({ node_id: entry.node.id, code: 'ROUTING_UNAVAILABLE' });
      continue;
    }
    if (!isResolvedBuilderRouting(builderRouting)) {
      skipped.push({ node_id: entry.node.id, code: 'ROUTING_INVALID' });
      continue;
    }

    const attempt = await store.createAttempt(workId, entry.node.id, attemptId, attemptNumber, jobId, builderRouting);
    if ('error' in attempt) {
      skipped.push({ node_id: entry.node.id, code: 'ATTEMPT_CREATION_FAILED' });
      continue;
    }

    try {
      await queue.ensureJob(makeQueueEnvelope(workId, entry.node.id, attemptNumber));
    } catch {
      // Attempt creation is durable. Startup reconciliation can retry the
      // idempotent ensureJob call, while this pass reports the interrupted
      // delivery instead of pretending the frontier was empty.
      skipped.push({ node_id: entry.node.id, code: 'QUEUE_ENQUEUE_FAILED' });
      continue;
    }
    dispatched.push({ attempt_id: attemptId, job_id: jobId });
  }

  return { dispatched, skipped };
}
