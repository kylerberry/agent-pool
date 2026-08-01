/**
 * DAG-topology exclusion for worker-bound payloads.
 *
 * A Pool Worker is DAG-unaware (ADR-010): it sees one unit, never the structure
 * around it. Schema `additionalProperties: false` already rejects topology at the
 * top level of each contract; this pass is the defence-in-depth sweep that also
 * covers nested free-form values, so structure cannot reach a worker by riding
 * inside an otherwise-permitted field.
 */

import { isPlainObject } from './contracts.ts';

export const DAG_TOPOLOGY_KEYS: readonly string[] = Object.freeze([
  'depends_on',
  'dependson',
  'dependencies',
  'dag',
  'dag_id',
  'nodes',
  'edges',
  'ready_frontier',
  'frontier',
  'downstream',
  'upstream',
  'successors',
  'predecessors',
  'topology',
  'graph',
  'sibling_nodes',
  'node_graph',
]);

const TOPOLOGY_KEY_SET = new Set(DAG_TOPOLOGY_KEYS);

/**
 * Return the path of the first DAG-topology key found anywhere in `value`, or
 * `null` when the payload is topology-free. Cycles are tolerated so a hostile
 * self-referential payload cannot hang the check.
 */
export function findDagTopology(value: unknown, path = 'payload', seen = new Set<unknown>()): string | null {
  if (!isPlainObject(value) && !Array.isArray(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findDagTopology(value[index], `${path}[${index}]`, seen);
      if (hit !== null) return hit;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (TOPOLOGY_KEY_SET.has(key.toLowerCase())) return `${path}.${key}`;
    const hit = findDagTopology(child, `${path}.${key}`, seen);
    if (hit !== null) return hit;
  }
  return null;
}
