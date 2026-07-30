import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { breadthRetrieval } from "../../src/domains/codebase-knowledge/breadth-retrieval.ts";
import { openCache, publishBlob, writeCache } from "../../src/domains/codebase-knowledge/controller-index-cache.ts";
import { makeIndexRevision, cacheKey } from "../../src/domains/codebase-knowledge/contracts.ts";

function buildGraph() {
  return {
    nodes: [
      { id: "a", label: "A", source_file: "src/a.js", file_type: "function" },
      { id: "b", label: "B", source_file: "src/b.js", file_type: "function" },
    ],
    links: [
      { source: "a", target: "b", relation: "calls" },
    ],
  };
}

async function seedCache(graph: unknown, entries: { relativePath: string; mode: number; size: number; digest: string }[] = []) {
  const root = mkdtempSync(join(tmpdir(), "ck-breadth-"));
  const cache = await openCache(root);
  const graphData = Buffer.from(JSON.stringify(graph));
  const revision = makeIndexRevision({ owner: "o", name: "r" }, "a".repeat(40), "0.9.25", "1", "sha256:manifest");
  const blobPath = await publishBlob(cache, revision, graphData);
  await writeCache(cache, {
    key: cacheKey(revision),
    revision,
    manifest: {
      repository: revision.repository,
      head: revision.head,
      entries: entries.map((e) => ({ ...e, type: "file" as const })),
      digest: "sha256:manifest",
    },
    graphPath: blobPath,
    createdAt: Date.now(),
    integrity: { algorithm: "sha256", digest: createHash("sha256").update(graphData).digest("hex") },
  });
  return { cache, revision };
}

test("breadthRetrieval uses Graphify node-link schema", async () => {
  const { cache, revision } = await seedCache(buildGraph(), [
    { relativePath: "src/a.js", mode: 0o644, size: 1, digest: "sha256:da" },
    { relativePath: "src/b.js", mode: 0o644, size: 1, digest: "sha256:db" },
  ]);
  const result = await breadthRetrieval(cache, revision);
  assert.equal(result.units.length, 2);
  assert.equal(result.edges.length, 1);
  const unitA = result.units.find((u) => u.id === "a");
  assert.equal(unitA?.sourcePath, "src/a.js");
  assert.equal(unitA?.kind, "function");
  assert.equal(result.edges[0].relation, "calls");
});

test("breadthRetrieval reports truncation with reason", async () => {
  const graph = {
    nodes: Array.from({ length: 5 }, (_, i) => ({ id: String(i), source_file: `src/${i}.js`, file_type: "function" })),
    links: Array.from({ length: 5 }, (_, i) => ({ source: String(i), target: String((i + 1) % 5) })),
  };
  const entries = Array.from({ length: 5 }, (_, i) => ({
    relativePath: `src/${i}.js`,
    mode: 0o644,
    size: 1,
    digest: `sha256:d${i}`,
  }));
  const { cache, revision } = await seedCache(graph, entries);
  const result = await breadthRetrieval(cache, revision, { maxUnits: 2, maxEdges: 2 });
  assert.equal(result.truncated, true);
  assert.match(result.truncationReason || "", /unit budget/);
  assert.match(result.truncationReason || "", /edge budget/);
});

test("breadthRetrieval rejects unvalidated source_file and dangling links", async () => {
  const badGraph = {
    nodes: [{ id: "a", source_file: "../outside.js" }],
    links: [{ source: "a", target: "missing" }],
  };
  const { cache, revision } = await seedCache(badGraph);
  await assert.rejects(() => breadthRetrieval(cache, revision), /invalid source_file|not in manifest|unknown target node/);
});
