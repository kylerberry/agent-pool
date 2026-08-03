import type { ApprovedNode } from './contracts.ts';

export type FrontierNode = {
  readonly node: ApprovedNode;
  readonly ready_after_scheduling: boolean;
  readonly blocker_node_id: string | null;
};

export function computeReadyFrontier(
  nodes: readonly ApprovedNode[],
  passedIds: ReadonlySet<string>,
  schedulingBlockers: ReadonlyMap<string, string>,
): readonly FrontierNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const frontier: FrontierNode[] = [];
  for (const node of nodes) {
    if (passedIds.has(node.id)) continue;
    const allDepsPassed = node.depends_on.every((dep) => passedIds.has(dep));
    if (!allDepsPassed) continue;
    const blocker = schedulingBlockers.get(node.id) ?? null;
    frontier.push({
      node,
      ready_after_scheduling: blocker === null,
      blocker_node_id: blocker,
    });
  }
  return frontier.sort((a, b) => a.node.id.localeCompare(b.node.id));
}
