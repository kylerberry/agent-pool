import test from "node:test";
import assert from "node:assert/strict";
import {
  makeIndexRevision,
  cacheKey,
  assertRepoIdentity,
  assertIndexRevision,
  assertCacheRecord,
  assertGraphifyGraph,
  isSensitivePath,
  DEFAULT_SENSITIVE_PATH_POLICY,
} from "../../src/domains/codebase-knowledge/contracts.ts";

test("assertRepoIdentity validates owner and name", () => {
  assert.deepEqual(assertRepoIdentity({ owner: "o", name: "n" }), { owner: "o", name: "n" });
  assert.throws(() => assertRepoIdentity({ owner: "" }), /owner/);
  assert.throws(() => assertRepoIdentity({ owner: "o", name: "" }), /name/);
});

test("makeIndexRevision produces a stable indexRevision", () => {
  const r1 = makeIndexRevision({ owner: "o", name: "n" }, "a".repeat(40), "0.9.25", "1", "sha256:m");
  const r2 = makeIndexRevision({ owner: "o", name: "n" }, "a".repeat(40), "0.9.25", "1", "sha256:m");
  assert.equal(r1.indexRevision, r2.indexRevision);
  assert.ok(r1.createdAt);
});

test("cache key isolates every tuple component", () => {
  const base = makeIndexRevision({ owner: "o", name: "n" }, "a".repeat(40), "0.9.25", "1", "sha256:m");
  const headDiff = makeIndexRevision({ owner: "o", name: "n" }, "b".repeat(40), "0.9.25", "1", "sha256:m");
  const ownerDiff = makeIndexRevision({ owner: "x", name: "n" }, "a".repeat(40), "0.9.25", "1", "sha256:m");
  const versionDiff = makeIndexRevision({ owner: "o", name: "n" }, "a".repeat(40), "0.9.26", "1", "sha256:m");
  assert.notEqual(cacheKey(base), cacheKey(headDiff));
  assert.notEqual(cacheKey(base), cacheKey(ownerDiff));
  assert.notEqual(cacheKey(base), cacheKey(versionDiff));
});

test("assertIndexRevision rejects invalid head", () => {
  const rev = makeIndexRevision({ owner: "o", name: "n" }, "short", "0.9.25", "1", "sha256:m");
  assert.throws(() => assertIndexRevision(rev), /full 40-character SHA/);
});

test("assertCacheRecord validates key and integrity", () => {
  const revision = makeIndexRevision({ owner: "o", name: "n" }, "a".repeat(40), "0.9.25", "1", "sha256:m");
  const record = {
    key: cacheKey(revision),
    revision,
    manifest: { repository: revision.repository, head: revision.head, entries: [], digest: "sha256:m" },
    graphPath: "/tmp/g.json",
    createdAt: Date.now(),
    integrity: { algorithm: "sha256", digest: "abc" },
  };
  assert.doesNotThrow(() => assertCacheRecord(record));
  assert.throws(() => assertCacheRecord({ ...record, integrity: { algorithm: "md5", digest: "abc" } }), /sha256/);
});

test("assertGraphifyGraph requires node-link links", () => {
  assert.doesNotThrow(() => assertGraphifyGraph({ nodes: [], links: [] }));
  assert.throws(() => assertGraphifyGraph({ nodes: [], edges: [] }), /links/);
});

test("cache key includes sensitive path policy version", () => {
  const base = makeIndexRevision({ owner: "o", name: "n" }, "a".repeat(40), "0.9.25", "1", "sha256:m");
  const policyV2 = makeIndexRevision(
    { owner: "o", name: "n" },
    "a".repeat(40),
    "0.9.25",
    "1",
    "sha256:m",
    { version: "2", patterns: [] },
  );
  assert.notEqual(cacheKey(base), cacheKey(policyV2));
});

test("isSensitivePath matches default controller policy", () => {
  assert.equal(isSensitivePath("src/credentials.ts", DEFAULT_SENSITIVE_PATH_POLICY), true);
  assert.equal(isSensitivePath(".env.production", DEFAULT_SENSITIVE_PATH_POLICY), true);
  assert.equal(isSensitivePath("src/index.ts", DEFAULT_SENSITIVE_PATH_POLICY), false);
});
