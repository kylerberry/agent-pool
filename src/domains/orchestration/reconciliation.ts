import type { OrchestrationStore } from './sqlite-store.ts';
import type { QueuePort } from './contracts.ts';
import { deriveJobId, makeQueueEnvelope } from './attempt-dispatch.ts';

/**
 * Idempotent startup reconciliation.
 *
 * - Ensures deterministic identifier-only jobs for created attempts.
 * - Reclaims expired leases at a higher generation (attempt becomes claimable).
 * - Completes authorized accepted results exactly once, using the persisted
 *   expected node version and recorded outcome.
 */
export async function reconcile(
  store: OrchestrationStore,
  queue: QueuePort,
  now: Date,
  leaseDurationMs: number,
): Promise<void> {
  const created = await store.listCreatedAttempts();
  for (const attempt of created) {
    const envelope = makeQueueEnvelope(attempt.work_id, attempt.node_id, attempt.attempt_number);
    await queue.ensureJob(envelope);
    await store.setJobId(attempt.attempt_id, envelope.job_id);
  }

  const expired = await store.listAttemptsNeedingReconciliation(now);
  for (const attempt of expired) {
    if (attempt.state === 'leased') {
      await store.reclaimLease(attempt.attempt_id, 'reconciliation', now);
    }
  }

  const authorized = await store.listAuthorizedResults();
  for (const auth of authorized) {
    const node = await store.listNodes(auth.work_id).then((nodes) => nodes.find((n) => n.node_id === auth.node_id));
    if (node && node.state !== 'passed' && node.state !== 'failed') {
      const completed = await store.completeAuthorizedResult(auth.work_id, auth.node_id, auth.attempt_id);
      if (!('error' in completed)) {
        await queue.removeJob(deriveJobId(auth.attempt_id));
      }
    }
  }
}
