import type { NodeState, OrchestrationError } from './contracts.ts';

export const ALLOWED_TRANSITIONS: Readonly<Record<NodeState, ReadonlySet<NodeState>>> = {
  pending: new Set(['ready']),
  ready: new Set(['in_progress']),
  in_progress: new Set(['passed', 'failed']),
  passed: new Set(),
  failed: new Set(),
};

export function isValidTransition(from: NodeState, to: NodeState): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionError(from: NodeState, to: NodeState): OrchestrationError {
  return {
    code: 'INVALID_TRANSITION',
    message: `transition from ${from} to ${to} is not allowed`,
  };
}
