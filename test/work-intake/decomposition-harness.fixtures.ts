import assert from 'node:assert/strict';

import type {
  BreadthRetriever,
  DecompositionCandidate,
  DecompositionFailure,
  DecompositionJob,
  DecompositionModelInvoker,
} from '../../src/domains/work-intake/decomposition-contracts.ts';
import { isDecompositionCandidate, isDecompositionFailure } from '../../src/domains/work-intake/decomposition-contracts.ts';
import type { BreadthResult, GraphEdge, GraphUnit, IndexRevision } from '../../src/domains/codebase-knowledge/contracts.ts';

export const VALID_INDEX_REVISION: IndexRevision = {
  repository: { owner: 'owner', name: 'repo' },
  head: 'a'.repeat(40),
  graphifyVersion: '0.9.25',
  indexSchemaVersion: '1',
  sensitivePathPolicyVersion: '1',
  manifestDigest: 'sha256:manifest',
  indexRevision: 'rev-1',
  createdAt: new Date().toISOString(),
};

export function validJob(overrides: Partial<DecompositionJob> = {}): DecompositionJob {
  return {
    jobId: 'job-1',
    spec: {
      intent: 'Add user authentication',
      acceptanceCriteria: ['Users can log in'],
    },
    rawSpec: 'Implement a login endpoint.',
    targetRepository: { owner: 'owner', name: 'repo' },
    head: 'a'.repeat(40),
    indexRevision: VALID_INDEX_REVISION,
    ...overrides,
  };
}

export function makeBreadthResult(overrides?: Partial<BreadthResult>): BreadthResult;
export function makeBreadthResult(units?: GraphUnit[], edges?: GraphEdge[], truncated?: boolean): BreadthResult;
export function makeBreadthResult(
  overridesOrUnits: Partial<BreadthResult> | GraphUnit[] = {},
  edges: GraphEdge[] = [],
  truncated = false,
): BreadthResult {
  if (Array.isArray(overridesOrUnits)) {
    return { revision: VALID_INDEX_REVISION, units: overridesOrUnits, edges, truncated };
  }
  return {
    revision: VALID_INDEX_REVISION,
    units: [{ id: 'u1', label: 'Login', kind: 'function', sourcePath: 'src/auth.js' }],
    edges: [],
    truncated: false,
    ...overridesOrUnits,
  };
}

export function makeRetriever(result: BreadthResult): BreadthRetriever {
  return { retrieve: async () => result };
}

export function makeInvoker(responses: string[]): DecompositionModelInvoker {
  let callCount = 0;
  return {
    invoke: async () => {
      const response = responses[callCount] ?? '[]';
      callCount += 1;
      return response;
    },
  };
}

export function flatCandidate(): DecompositionCandidate {
  return {
    nodes: [
      { id: 'auth-1', intent: 'Create login endpoint', change_spec: 'Add POST /login route', acceptance_criteria: ['Returns token on valid credentials'], depends_on: [] },
      { id: 'auth-2', intent: 'Add session expiry', change_spec: 'Set 24h TTL on sessions', acceptance_criteria: ['Expired sessions are rejected'], depends_on: ['auth-1'] },
    ],
  };
}

export function convergentCandidate(): DecompositionCandidate {
  return {
    nodes: [
      { id: 'a', intent: 'A', change_spec: 'do A', acceptance_criteria: ['A passes'], depends_on: [] },
      { id: 'b', intent: 'B', change_spec: 'do B', acceptance_criteria: ['B passes'], depends_on: [] },
      { id: 'c', intent: 'C', change_spec: 'do C', acceptance_criteria: ['C passes'], depends_on: ['a', 'b'] },
    ],
  };
}

export function getCandidate(result: unknown): DecompositionCandidate {
  assert.ok(isDecompositionCandidate(result), 'expected candidate');
  return result as DecompositionCandidate;
}

export function getFailure(result: unknown): DecompositionFailure {
  assert.ok(isDecompositionFailure(result), `expected failure, got ${JSON.stringify(result)}`);
  return result as DecompositionFailure;
}
