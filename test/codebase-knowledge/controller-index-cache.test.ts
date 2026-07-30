import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync, mkdirSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openCache, readCache, writeCache, evictCache, publishBlob } from "../../src/domains/codebase-knowledge/controller-index-cache.ts";
import { makeIndexRevision, cacheKey } from "../../src/domains/codebase-knowledge/contracts.ts";

function makeRevision(head = "abcd1234abcd1234abcd1234abcd1234abcd1234") {
  const repo = { owner: "o", name: "r" };
  return makeIndexRevision(repo, head, "0.9.25", "1", "sha256:manifest");
}

function tempGraph(content = JSON.stringify({ nodes: [], links: [] })) {
  const path = join(mkdtempSync(join(tmpdir(), "ck-graph-")), "graph.json");
  writeFileSync(path, content);
  return path;
}

function makeRecord(label: string, graphPath: string, graphData: Buffer) {
  const hash = createHash("sha256").update(label).digest("hex").slice(0, 40);
  const revision = makeRevision(hash);
  const digest = createHash("sha256").update(graphData).digest("hex");
  return {
    key: cacheKey(revision),
    revision,
    manifest: { repository: revision.repository, head: revision.head, entries: [], digest: "sha256:manifest" },
    graphPath,
    createdAt: Date.now(),
    integrity: { algorithm: "sha256", digest: digest },
  };
}

test("openCache rejects roots inside target", async () => {
  const target = mkdtempSync(join(tmpdir(), "ck-cache-target-"));
  const insideAgentPool = join(target, ".agent-pool", "cache");
  const insideTarget = join(target, "cache");
  mkdirSync(insideAgentPool, { recursive: true });
  mkdirSync(insideTarget, { recursive: true });
  await assert.rejects(
    () => openCache(insideAgentPool),
    /forbidden cache root/,
  );
  await assert.rejects(
    () => openCache(insideTarget, { targetRoot: target }),
    /inside target repository/,
  );
});

test("writeCache stores a record and readCache retrieves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-"));
  const cache = await openCache(root);
  const graphData = Buffer.from(JSON.stringify({ nodes: [{ id: "a" }], links: [] }));
  const blobPath = await publishBlob(cache, makeRevision(), graphData);
  const record = makeRecord("head-a", blobPath, graphData);
  await writeCache(cache, record);
  const retrieved = await readCache(cache, record.key);
  assert.equal(retrieved?.key, record.key);
  assert.equal(retrieved?.revision.head, record.revision.head);
  assert.equal(retrieved?.integrity.digest, record.integrity.digest);
});

test("readCache regenerates missing entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-miss-"));
  const cache = await openCache(root);
  const result = await readCache(cache, "no-such-key");
  assert.equal(result, undefined);
});

test("readCache regenerates corrupt graph blob", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-corrupt-"));
  const cache = await openCache(root);
  const revision = makeRevision();
  const goodData = Buffer.from(JSON.stringify({ nodes: [{ id: "a" }], links: [] }));
  const blobPath = await publishBlob(cache, revision, goodData);
  const record = makeRecord(revision.head, blobPath, goodData);
  await writeCache(cache, record);
  // Corrupt the blob.
  writeFileSync(blobPath, "tampered");
  const retrieved = await readCache(cache, record.key);
  assert.equal(retrieved, undefined);
});

test("evictCache enforces byte limit including blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-evict-"));
  const cache = await openCache(root, { maxBytes: 1 });
  const graphData = Buffer.from(JSON.stringify({ nodes: [{ id: "a", b: "x".repeat(1000) }], links: [] }));
  const revision = makeRevision();
  const blobPath = await publishBlob(cache, revision, graphData);
  const record = makeRecord(revision.head, blobPath, graphData);
  await writeCache(cache, record);
  await evictCache(cache);
  const retrieved = await readCache(cache, record.key);
  assert.equal(retrieved, undefined);
});

test("writeCache rejects mismatched key", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-key-"));
  const cache = await openCache(root);
  const graphData = Buffer.from("{}");
  const revision = makeRevision();
  const blobPath = await publishBlob(cache, revision, graphData);
  const record = makeRecord(revision.head, blobPath, graphData);
  record.key = "tampered";
  await assert.rejects(() => writeCache(cache, record), /does not match derived key/);
});

test("publishBlob writes atomically inside cache root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-blob-"));
  const cache = await openCache(root);
  const data = Buffer.from("{\"nodes\":[],\"links\":[]}");
  const blobPath = await publishBlob(cache, makeRevision(), data);
  assert.ok(blobPath.startsWith(realpathSync(root)));
  assert.equal(readFileSync(blobPath, "utf8"), data.toString("utf8"));
});

test("evictCache removes referenced blobs and orphan blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-blob-evict-"));
  let cache = await openCache(root);

  const orphanRevision = makeRevision("abcd1234abcd1234abcd1234abcd1234abcd1234");
  const orphanData = Buffer.from(JSON.stringify({ nodes: [], links: [] }));
  const orphanBlob = await publishBlob(cache, orphanRevision, orphanData);

  const graphData = Buffer.from(JSON.stringify({ nodes: [{ id: "a", b: "x".repeat(1000) }], links: [] }));
  const revision = makeRevision();
  const blobPath = await publishBlob(cache, revision, graphData);
  const record = makeRecord(revision.head, blobPath, graphData);
  await writeCache(cache, record);

  assert.ok(existsSync(blobPath));
  assert.ok(existsSync(orphanBlob));

  // Force eviction by shrinking the byte budget.
  cache = await openCache(root, { maxBytes: 1 });
  await evictCache(cache);

  assert.equal(await readCache(cache, record.key), undefined);
  assert.equal(existsSync(blobPath), false);
  assert.equal(existsSync(orphanBlob), false);
});

test("evictCache removes expired orphan blobs while retaining fresh ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-orphan-age-"));
  const cache = await openCache(root, { maxAgeMs: 1000 });

  const freshRevision = makeRevision("0000000000000000000000000000000000000000");
  const staleRevision = makeRevision("1111111111111111111111111111111111111111");
  const data = Buffer.from(JSON.stringify({ nodes: [], links: [] }));

  const freshBlob = await publishBlob(cache, freshRevision, data);
  const staleBlob = await publishBlob(cache, staleRevision, data);

  // Age the stale orphan past maxAgeMs without referencing it from any record.
  const oldTime = new Date(Date.now() - 2000);
  await utimes(staleBlob, oldTime, oldTime);

  // Budgets are intentionally generous; only age should trigger eviction.
  await evictCache(cache);

  assert.equal(existsSync(staleBlob), false, "expired orphan blob should be removed");
  assert.equal(existsSync(freshBlob), true, "fresh orphan blob should be retained");
});
