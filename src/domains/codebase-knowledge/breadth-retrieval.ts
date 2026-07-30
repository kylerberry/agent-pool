import { readFile } from "node:fs/promises";
import type { IndexRevision, BreadthResult, GraphUnit, GraphEdge, SourceManifest, GraphifyNode, GraphifyLink } from "./contracts.ts";
import { assertGraphifyGraph, cacheKey, isSensitivePath } from "./contracts.ts";
import { normalizeRelativePath } from "./target-repository.ts";
import type { CacheHandle } from "./controller-index-cache.ts";
import { readCache, openCache } from "./controller-index-cache.ts";

export interface BreadthQuery {
  maxUnits?: number;
  maxEdges?: number;
}

function toUnit(node: { id: string; label?: string; source_file?: string; file_type?: string; community?: number }): GraphUnit {
  return {
    id: node.id,
    label: node.label || node.id,
    kind: node.file_type || "unknown",
    sourcePath: node.source_file || "",
    community: typeof node.community === "number" ? node.community : undefined,
  };
}

function toEdge(link: { source: string; target: string; relation?: string; label?: string }): GraphEdge {
  return {
    source: link.source,
    target: link.target,
    relation: link.relation || link.label || "relates-to",
  };
}

function validateSourcePath(
  nodeId: string,
  sourceFile: string | undefined,
  manifest: SourceManifest,
): string {
  if (sourceFile === undefined || sourceFile === "") {
    throw new Error(`graph node ${nodeId} missing source_file`);
  }
  let relative: string;
  try {
    relative = normalizeRelativePath(sourceFile);
  } catch {
    throw new Error(`graph node ${nodeId} has an invalid source_file: ${sourceFile}`);
  }
  if (isSensitivePath(relative)) {
    throw new Error(`graph node ${nodeId} references sensitive path: ${relative}`);
  }
  const found = manifest.entries.find((e) => e.relativePath === relative);
  if (!found) {
    throw new Error(`graph node ${nodeId} source_file not in manifest: ${relative}`);
  }
  return relative;
}

export function validateGraphAgainstManifest(graph: { nodes: GraphifyNode[]; links: GraphifyLink[] }, manifest: SourceManifest): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || node.id === "") {
      throw new Error("graph node id must be a non-empty string");
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`graph contains duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
    validateSourcePath(node.id, node.source_file, manifest);
  }
  for (const link of graph.links) {
    if (typeof link.source !== "string" || link.source === "") {
      throw new Error("graph link source must be a non-empty string");
    }
    if (typeof link.target !== "string" || link.target === "") {
      throw new Error("graph link target must be a non-empty string");
    }
    if (!nodeIds.has(link.source)) {
      throw new Error(`graph link references unknown source node: ${link.source}`);
    }
    if (!nodeIds.has(link.target)) {
      throw new Error(`graph link references unknown target node: ${link.target}`);
    }
  }
}

export async function breadthRetrieval(
  cacheLike: CacheHandle | { root: string },
  revision: IndexRevision,
  query: BreadthQuery = {},
): Promise<BreadthResult> {
  const cache = "root" in cacheLike && "maxBytes" in cacheLike
    ? cacheLike
    : await openCache(cacheLike.root);
  const key = cacheKey(revision);
  const record = await readCache(cache, key);
  if (!record) throw new Error("index not found in cache");

  const raw = JSON.parse(await readFile(record.graphPath, "utf8"));
  const graph = assertGraphifyGraph(raw);
  validateGraphAgainstManifest(graph, record.manifest);

  const maxUnits = query.maxUnits ?? 200;
  const maxEdges = query.maxEdges ?? 500;

  const units = graph.nodes.slice(0, maxUnits).map((n) => toUnit(n));
  const edges = graph.links.slice(0, maxEdges).map((l) => toEdge(l));

  const truncatedUnits = graph.nodes.length > units.length;
  const truncatedEdges = graph.links.length > edges.length;
  const truncated = truncatedUnits || truncatedEdges;
  const reasons: string[] = [];
  if (truncatedUnits) reasons.push(`unit budget ${maxUnits} exceeded (${graph.nodes.length})`);
  if (truncatedEdges) reasons.push(`edge budget ${maxEdges} exceeded (${graph.links.length})`);

  return {
    revision: record.revision,
    units,
    edges,
    truncated,
    truncationReason: truncated ? reasons.join("; ") : undefined,
  };
}
