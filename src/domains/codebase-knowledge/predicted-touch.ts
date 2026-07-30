import { createHash } from "node:crypto";
import type { IndexRevision, PredictedTouchEvidence, GraphUnit, GraphEdge } from "./contracts.ts";
import { ALGORITHM_VERSION } from "./contracts.ts";
import type { CacheHandle } from "./controller-index-cache.ts";
import { breadthRetrieval } from "./breadth-retrieval.ts";

function normalizeProposed(value: string): string {
  return value.replace(/^\.\//, "");
}

function unitMatches(unit: GraphUnit, proposed: string[]): boolean {
  for (const p of proposed) {
    const norm = normalizeProposed(p);
    if (unit.sourcePath.includes(norm) || unit.id.includes(norm) || unit.label.includes(norm)) {
      return true;
    }
  }
  return false;
}

function freezeId(revision: IndexRevision, proposedUnits: string[]): string {
  const hash = createHash("sha256");
  hash.update(revision.indexRevision);
  for (const p of proposedUnits.slice().sort()) hash.update(p);
  return `gate1-freeze-${hash.digest("hex").slice(0, 32)}`;
}

export async function derivePredictedTouch(
  cache: CacheHandle | { root: string },
  revision: IndexRevision,
  proposedUnits: string[],
): Promise<PredictedTouchEvidence> {
  if (!Array.isArray(proposedUnits) || proposedUnits.length === 0) {
    throw new Error("proposedUnits must be a non-empty array");
  }
  const result = await breadthRetrieval(cache, revision);

  const likelySet = new Map<string, GraphUnit>();
  for (const unit of result.units) {
    if (unitMatches(unit, proposedUnits)) {
      likelySet.set(unit.id, unit);
    }
  }
  const likelyUnits = Array.from(likelySet.keys()).slice(0, 50);

  const likelyIds = new Set(likelyUnits);
  const sharedSurfaces: Array<{ unitA: string; unitB: string; surface: string }> = [];
  for (const edge of result.edges.slice(0, 200)) {
    const a = likelyIds.has(edge.source);
    const b = likelyIds.has(edge.target);
    if (a || b) {
      sharedSurfaces.push({ unitA: edge.source, unitB: edge.target, surface: edge.relation });
    }
  }

  const sourceProvenance = result.units
    .filter((u) => likelyIds.has(u.id))
    .map((u) => ({ unit: u.id, sourcePath: u.sourcePath }));

  return {
    indexRevision: result.revision,
    proposedUnits,
    likelyUnits,
    sharedSurfaces,
    sourceProvenance,
    confidenceBasis: "structural-edge-breadth",
    algorithmVersion: ALGORITHM_VERSION,
    gate1FreezeId: freezeId(result.revision, proposedUnits),
  };
}
