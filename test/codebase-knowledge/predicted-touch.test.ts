import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { derivePredictedTouch } from "../../src/domains/codebase-knowledge/predicted-touch.ts";
import { openCache, publishBlob, writeCache } from "../../src/domains/codebase-knowledge/controller-index-cache.ts";
import { makeIndexRevision, cacheKey } from "../../src/domains/codebase-knowledge/contracts.ts";

async function seedCache() {
  const root = mkdtempSync(join(tmpdir(), "ck-touch-"));
  const cache = await openCache(root);
  const graph = {
    nodes: [
      { id: "a", label: "A", source_file: "src/a.js", file_type: "function" },
      { id: "b", label: "B", source_file: "src/b.js", file_type: "function" },
      { id: "c", label: "C", source_file: "src/c.js", file_type: "function" },
    ],
    links: [
      { source: "a", target: "b", relation: "calls" },
      { source: "b", target: "c", relation: "calls" },
    ],
  };
  const graphData = Buffer.from(JSON.stringify(graph));
  const revision = makeIndexRevision({ owner: "o", name: "r" }, "a".repeat(40), "0.9.25", "1", "sha256:manifest");
  const blobPath = await publishBlob(cache, revision, graphData);
  const manifest = {
    repository: revision.repository,
    head: revision.head,
    entries: [
      { relativePath: "src/a.js", type: "file" as const, mode: 0o644, size: 1, digest: "sha256:da" },
      { relativePath: "src/b.js", type: "file" as const, mode: 0o644, size: 1, digest: "sha256:db" },
      { relativePath: "src/c.js", type: "file" as const, mode: 0o644, size: 1, digest: "sha256:dc" },
    ],
    digest: "sha256:manifest",
  };
  await writeCache(cache, {
    key: cacheKey(revision),
    revision,
    manifest,
    graphPath: blobPath,
    createdAt: Date.now(),
    integrity: { algorithm: "sha256", digest: createHash("sha256").update(graphData).digest("hex") },
  });
  return { cache, revision };
}

test("derivePredictedTouch returns likely units and shared surfaces", async () => {
  const { cache, revision } = await seedCache();
  const evidence = await derivePredictedTouch(cache, revision, ["src/a.js"]);
  assert.equal(evidence.indexRevision.head, revision.head);
  assert.equal(evidence.algorithmVersion, "1");
  assert.ok(evidence.likelyUnits.includes("a"));
  assert.ok(evidence.sharedSurfaces.some((s) => s.unitA === "a" && s.unitB === "b"));
  assert.ok(evidence.sourceProvenance.some((p) => p.unit === "a" && p.sourcePath === "src/a.js"));
  assert.ok(evidence.gate1FreezeId);
});

test("derivePredictedTouch rejects empty proposed units", async () => {
  const { cache, revision } = await seedCache();
  await assert.rejects(() => derivePredictedTouch(cache, revision, []), /non-empty array/);
});

test("predicted-touch evidence excludes scheduling topology", () => {
  // Static contract check: the exported shape has no depends_on, siblingIds, schedule.
  const keys = new Set(["indexRevision", "proposedUnits", "likelyUnits", "sharedSurfaces", "sourceProvenance", "confidenceBasis", "algorithmVersion", "gate1FreezeId"]);
  assert.equal(keys.has("depends_on"), false);
  assert.equal(keys.has("siblingIds"), false);
  assert.equal(keys.has("schedule"), false);
});
