import type { ApprovedNode, OrchestrationError, QueueEnvelope } from './contracts.ts';
import { validateQueueEnvelope } from './contracts.ts';
import { validateAttemptContracts } from '../agent-execution/index.ts';
import type { OrchestrationStore } from './sqlite-store.ts';

export type { OrchestrationStore } from './sqlite-store.ts';

export function deriveAttemptId(workId: string, nodeId: string, attemptNumber: number): string {
  return `att://${workId}/${nodeId}/${attemptNumber}`;
}

export function deriveJobId(attemptId: string): string {
  return `job://${attemptId}`;
}

export function deriveCriterionId(workId: string, nodeId: string, index: number, text: string): string {
  return `crit://${workId}/${nodeId}/${index}/${text.length}`;
}

export function makeQueueEnvelope(workId: string, nodeId: string, attemptNumber: number): QueueEnvelope {
  const attemptId = deriveAttemptId(workId, nodeId, attemptNumber);
  return {
    job_id: deriveJobId(attemptId),
    attempt_id: attemptId,
    node_id: nodeId,
    work_id: workId,
  };
}

export function projectAttemptContract(
  node: ApprovedNode,
  workId: string,
  attemptId: string,
  attemptNumber: number,
  repo: string,
  branch: string,
) {
  return deepFreeze({
    schema_version: 1,
    node_id: node.id,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
    intent: node.intent,
    change_spec: node.change_spec,
    acceptance_criteria: node.acceptance_criteria.map((text, index) => ({
      id: deriveCriterionId(workId, node.id, index, text),
      text,
    })),
    criteria_origin: {
      source: node.criteria_origin_source,
      source_id: node.criteria_origin_source_id,
    },
    target_repo: repo,
    target_branch: branch,
    prior_failure_context: [],
  });
}

/**
 * Exact queue consumer: validate the identifier-only envelope, rehydrate the
 * immutable attempt from SQLite, project a worker contract that contains no
 * DAG structure, and validate it against the Agent Execution boundary before handoff.
 */
export async function consumeQueueEnvelope(
  store: OrchestrationStore,
  envelope: unknown,
  expectations: { readonly nodeId: string; readonly attemptId: string; readonly targetRepo: string; readonly targetBranch: string },
): Promise<{ readonly contract: unknown } | { readonly error: OrchestrationError }> {
  const validation = validateQueueEnvelope(envelope);
  if (validation) return { error: validation };
  const ev = envelope as QueueEnvelope;

  if (ev.node_id !== expectations.nodeId || ev.attempt_id !== expectations.attemptId) {
    return { error: { code: 'QUEUE_ENVELOPE_INVALID', message: 'envelope identity does not match expectations' } };
  }

  const attempt = await store.getAttemptByJob(ev.job_id);
  if (!attempt) {
    return { error: { code: 'QUEUE_ENVELOPE_INVALID', message: 'job not found' } };
  }
  if (attempt.attempt_id !== ev.attempt_id || attempt.node_id !== ev.node_id || attempt.work_id !== ev.work_id) {
    return { error: { code: 'QUEUE_ENVELOPE_INVALID', message: 'envelope identifiers do not match stored attempt' } };
  }
  if (attempt.state !== 'created' && attempt.state !== 'leased') {
    return { error: { code: 'QUEUE_ENVELOPE_INVALID', message: 'attempt is not dispatchable' } };
  }

  const node = await store.getApprovedNode(attempt.work_id, attempt.node_id);
  if (!node) {
    return { error: { code: 'NODE_NOT_FOUND', message: 'node not found' } };
  }

  const work = await store.getWork(attempt.work_id);
  if (!work) {
    return { error: { code: 'WORK_NOT_FOUND', message: 'work not found' } };
  }

  const contract = projectAttemptContract(node, attempt.work_id, attempt.attempt_id, attempt.attempt_number, work.repo, work.branch);

  const validated = validateAttemptContracts([contract], {
    nodeId: attempt.node_id,
    attemptId: attempt.attempt_id,
    targetRepo: work.repo,
    targetBranch: work.branch,
  });
  if ('code' in validated) {
    return { error: { code: 'QUEUE_ENVELOPE_INVALID', message: validated.reason } };
  }

  return { contract };
}

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
