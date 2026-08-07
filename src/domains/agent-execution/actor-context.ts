/**
 * Launcher-owned structural actor identity.
 *
 * `actor_identity` is parameterless and derives from the immutable validated
 * execution context captured by the trusted bootstrap before task execution.
 * It accepts no actor-selection input, rereads no mutable workspace marker, and
 * exposes no credential or nonce.
 */

import type { ExecutionContextShape } from './contracts.ts';

export type ActorIdentity = {
  readonly actor: 'pool-worker';
  readonly authority: 'single-attempt-execution';
  readonly node_id: string;
  readonly attempt_id: string;
  readonly target_repo: string;
  readonly target_branch: string;
  readonly context_source: 'launcher-verified';
  readonly can_modify_pool_policy: false;
};

/**
 * Build a sanitized actor identity from a launcher-verified context.
 */
export function buildActorIdentity(context: ExecutionContextShape): ActorIdentity {
  return Object.freeze({
    actor: 'pool-worker',
    authority: 'single-attempt-execution',
    node_id: context.node_id,
    attempt_id: context.attempt_id,
    target_repo: context.target_repo,
    target_branch: context.target_branch,
    context_source: 'launcher-verified',
    can_modify_pool_policy: false,
  });
}

/**
 * Render the human-readable identity capsule that is injected into the system
 * prompt and startup diagnostics. It is derived only from the launcher-verified
 * execution context and never from workspace files or task text.
 */
export function renderIdentityCapsule(context: ExecutionContextShape): string {
  return [
    'ACTOR: Pool Worker',
    'AUTHORITY: Execute exactly one supplied attempt contract',
    `ATTEMPT: ${context.attempt_id}`,
    `TARGET: ${context.target_repo}@${context.target_branch}`,
    'NOT AUTHORIZED: Pool design, supervisor policy, DAG mutation, or other attempts',
  ].join('\n');
}

/**
 * Parameterless identity introspection for the Worker bootstrap.
 */
export function createActorIdentityAccessor(context: ExecutionContextShape): {
  readonly actor_identity: () => ActorIdentity;
} {
  const identity = buildActorIdentity(context);
  return Object.freeze({
    actor_identity: () => identity,
  });
}
