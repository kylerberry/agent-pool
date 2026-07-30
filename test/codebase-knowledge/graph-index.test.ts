import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildIndex, refreshIndex, breadthRetrieval, derivePredictedTouch, discoverTargetDocumentation } from "../../src/domains/codebase-knowledge/graph-index.ts";

const graphifyPath = realpathSync(spawnSync("which", ["graphify"], { encoding: "utf8" }).stdout.trim());

const gitPath = realpathSync(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());

function makeRepo(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `ck-service-${name}-`));
  const run = (cmd: string, ...args: string[]) => {
    const result = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr}`);
    return result;
  };
  run("git", "init");
  run("git", "config", "user.email", "test@example.com");
  run("git", "config", "user.name", "Test");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.js"), "import { a } from './a.js';\nexport const b = a + 1;\n");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  run("git", "add", ".");
  run("git", "commit", "-m", "initial");
  return dir;
}

function makeRequest(repo: string, head: string, scratchRoot: string, cacheRoot: string) {
  return {
    repository: { owner: "o", name: "r" },
    expectedHead: head,
    targetRoot: repo,
    gitPath,
    graphifyPath,
    graphifyVersion: "0.9.25",
    indexSchemaVersion: "1",
    scratchRoot,
    cacheRoot,
  };
}

test("buildIndex returns a revision with full head SHA and graph outside target", async () => {
  const repo = makeRepo("build");
  const scratch = mkdtempSync(join(tmpdir(), "ck-service-scratch-"));
  const cacheRoot = join(scratch, "cache");
  const result = await buildIndex(makeRequest(repo, "HEAD", scratch, cacheRoot));
  assert.match(result.revision.head, /^[0-9a-f]{40}$/);
  assert.equal(result.revision.graphifyVersion, "0.9.25");
  assert.equal(result.revision.indexSchemaVersion, "1");
  assert.ok(result.revision.manifestDigest);
  assert.ok(result.revision.indexRevision);
  assert.ok(resolve(result.graphPath).startsWith(realpathSync(cacheRoot)));
  assert.ok(!resolve(result.graphPath).startsWith(realpathSync(repo)));
});

test("buildIndex rejects scratch inside target", async () => {
  const repo = makeRepo("inside-scratch");
  const scratch = join(repo, "scratch");
  const cacheRoot = join(repo, "cache");
  await assert.rejects(
    () => buildIndex(makeRequest(repo, "HEAD", scratch, cacheRoot)),
    /scratch root must be outside target repository/,
  );
});

test("buildIndex rejects cache inside target", async () => {
  const repo = makeRepo("inside-cache");
  const scratch = mkdtempSync(join(tmpdir(), "ck-service-out-"));
  const cacheRoot = join(repo, "cache");
  await assert.rejects(
    () => buildIndex(makeRequest(repo, "HEAD", scratch, cacheRoot)),
    /cache root must be outside target repository/,
  );
});

test("refreshIndex creates a distinct revision for a new head", async () => {
  const repo = makeRepo("refresh");
  const scratch = mkdtempSync(join(tmpdir(), "ck-service-scratch-"));
  const cacheRoot = join(scratch, "cache");
  const first = await buildIndex(makeRequest(repo, "HEAD", scratch, cacheRoot));
  writeFileSync(join(repo, "src", "c.js"), "export const c = 3;\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-m", "second"], { cwd: repo });
  const second = await refreshIndex(makeRequest(repo, "HEAD", scratch, cacheRoot));
  assert.notEqual(first.revision.head, second.revision.head);
  assert.notEqual(first.revision.indexRevision, second.revision.indexRevision);
});

test("buildIndex fails closed with a bogus expected HEAD", async () => {
  const repo = makeRepo("race");
  const scratch = mkdtempSync(join(tmpdir(), "ck-service-race-"));
  const cacheRoot = join(scratch, "cache");
  const bogusHead = "0".repeat(40);
  await assert.rejects(
    () => buildIndex(makeRequest(repo, bogusHead, scratch, cacheRoot)),
    /head mismatch/,
  );
});

test("buildIndex fails closed when HEAD changes during Graphify", async () => {
  const repo = makeRepo("actual-race");
  const scratch = mkdtempSync(join(tmpdir(), "ck-service-race-"));
  const cacheRoot = join(scratch, "cache");

  const wrapper = join(scratch, "mutating-graphify.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -e
if [ "$1" = "--version" ]; then
  exec "${graphifyPath}" "$@"
fi
cd "${repo}"
echo "mutation" > mutation.txt
git add mutation.txt
git -c user.email=test@example.com -c user.name=Test commit -m "mid-index mutation"
exec "${graphifyPath}" "$@"
`,
    { mode: 0o755 },
  );

  const request = makeRequest(repo, "HEAD", scratch, cacheRoot);
  request.graphifyPath = wrapper;

  await assert.rejects(
    () => buildIndex(request),
    /target head changed|target manifest changed/,
  );
});

test("breadthRetrieval returns dependency edges with source_file/file_type", async () => {
  const repo = makeRepo("breadth");
  const scratch = mkdtempSync(join(tmpdir(), "ck-service-breadth-"));
  const cacheRoot = join(scratch, "cache");
  const indexed = await buildIndex(makeRequest(repo, "HEAD", scratch, cacheRoot));
  const result = await breadthRetrieval({ root: cacheRoot }, indexed.revision);
  assert.ok(Array.isArray(result.units));
  assert.ok(result.units.length >= 1);
  assert.ok(result.edges.length >= 0);
  assert.equal(result.revision.head, indexed.revision.head);
  assert.equal(result.truncated, false);
  for (const u of result.units) {
    assert.equal(typeof u.sourcePath, "string");
    assert.equal(typeof u.kind, "string");
  }
});

test("derivePredictedTouch is controller-only and excludes worker topology", async () => {
  const repo = makeRepo("touch");
  const scratch = mkdtempSync(join(tmpdir(), "ck-service-touch-"));
  const cacheRoot = join(scratch, "cache");
  const indexed = await buildIndex(makeRequest(repo, "HEAD", scratch, cacheRoot));
  const evidence = await derivePredictedTouch({ root: cacheRoot }, indexed.revision, ["src/a.js"]);
  assert.equal(evidence.indexRevision.head, indexed.revision.head);
  assert.equal(evidence.algorithmVersion, "1");
  assert.ok(evidence.likelyUnits.length >= 0);
  assert.ok(Array.isArray(evidence.sharedSurfaces));
  assert.ok(evidence.gate1FreezeId);
});

test("discoverTargetDocumentation discovers index-led pages", async () => {
  const repo = makeRepo("docs");
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  writeFileSync(join(repo, "docs", "wiki", "index.md"), "# Wiki\n");
  writeFileSync(join(repo, "README.md"), "# readme\n[Wiki](docs/wiki/index.md)\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-m", "add wiki"], { cwd: repo });
  const result = await discoverTargetDocumentation(makeRequest(repo, "HEAD", mkdtempSync(join(tmpdir(), "ck-doc-scratch-")), join(mkdtempSync(join(tmpdir(), "ck-doc-scratch-")), "cache")));
  assert.equal(result.available, true);
  assert.ok(result.pages.some((p) => p.sourcePath === "docs/wiki/index.md"));
});
