/**
 * Phase-scoped capability grants (ADR-029).
 *
 * Tool grants are per phase, not per container. The load-bearing one is A's write
 * denial: an evaluator that can edit the code it judges is a gate that can
 * rewrite its own exam. That is enforced here as a capability lookup, not as
 * prompt wording — prompt wording is not a security boundary.
 *
 * S may write, but only into an owner-approved target-repository knowledge sink.
 * Absent a sink, S emits a structured proposal; this module never invents one.
 */

import {
  createExecutionFailure,
  deepFreeze,
  type CraftsPhase,
  type ExecutionFailure,
} from './contracts.ts';

export type Capability = 'read' | 'grep' | 'graphify' | 'bash' | 'write' | 'edit' | 'security_tooling';

export type PhaseGrant = {
  readonly phase: CraftsPhase;
  readonly capabilities: readonly Capability[];
  /** Null means the phase may not write at all. */
  readonly writeScope: 'workspace' | 'knowledge-sink' | null;
};

const GRANTS: Readonly<Record<CraftsPhase, PhaseGrant>> = deepFreeze({
  C: { phase: 'C', capabilities: ['read', 'grep', 'graphify'], writeScope: null },
  R: { phase: 'R', capabilities: ['read', 'grep', 'graphify', 'bash', 'write', 'edit'], writeScope: 'workspace' },
  A: { phase: 'A', capabilities: ['read', 'grep', 'graphify'], writeScope: null },
  F: { phase: 'F', capabilities: ['read', 'grep', 'graphify', 'bash', 'write', 'edit'], writeScope: 'workspace' },
  T: { phase: 'T', capabilities: ['read', 'grep', 'graphify', 'security_tooling'], writeScope: null },
  S: { phase: 'S', capabilities: ['read', 'grep', 'write', 'edit'], writeScope: 'knowledge-sink' },
}) as Readonly<Record<CraftsPhase, PhaseGrant>>;

/** Look up a phase's grant. An unrecognised phase fails closed rather than defaulting. */
export function getPhaseGrant(phase: string): PhaseGrant | ExecutionFailure {
  const grant = Object.hasOwn(GRANTS, phase) ? GRANTS[phase as CraftsPhase] : undefined;
  if (!grant) return createExecutionFailure('UNKNOWN_PHASE', phase);
  return grant;
}

export function phaseHasCapability(phase: string, capability: Capability): boolean {
  const grant = getPhaseGrant(phase);
  if (!('capabilities' in grant)) return false;
  return grant.capabilities.includes(capability);
}

export type WriteAuthorization = {
  readonly phase: CraftsPhase;
  readonly scope: 'workspace' | 'knowledge-sink';
  readonly root: string;
};

/**
 * Authorize a write for a phase against a concrete root.
 *
 * `knowledgeSinkRoot` is supplied by the controller only when the target
 * repository has an owner-approved sink. When it is absent, S is denied the
 * write and is expected to emit a knowledge proposal instead.
 */
export function authorizeWrite(
  phase: string,
  roots: { readonly workspaceRoot: string; readonly knowledgeSinkRoot?: string },
): WriteAuthorization | ExecutionFailure {
  const grant = getPhaseGrant(phase);
  if (!('capabilities' in grant)) return grant;
  if (grant.writeScope === null || !grant.capabilities.includes('write')) {
    return createExecutionFailure('CAPABILITY_DENIED', `${grant.phase} may not write`);
  }
  if (grant.writeScope === 'workspace') {
    return Object.freeze({ phase: grant.phase, scope: 'workspace' as const, root: roots.workspaceRoot });
  }
  if (!roots.knowledgeSinkRoot) {
    return createExecutionFailure('WRITE_PATH_OUT_OF_SCOPE', 'no owner-approved knowledge sink is configured');
  }
  return Object.freeze({ phase: grant.phase, scope: 'knowledge-sink' as const, root: roots.knowledgeSinkRoot });
}
