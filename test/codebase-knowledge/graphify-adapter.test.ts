import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runGraphify, buildGraphifyEnv, readGraphifyGraph } from "../../src/domains/codebase-knowledge/graphify-adapter.ts";
import { captureManifest } from "../../src/domains/codebase-knowledge/target-repository.ts";
import { materializeProjection } from "../../src/domains/codebase-knowledge/scratch-projection.ts";

const graphifyPath = realpathSync(spawnSync("which", ["graphify"], { encoding: "utf8" }).stdout.trim());
const gitPath = realpathSync(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());

function baseRequest(targetRoot: string, scratchRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    repository: { owner: "o", name: "r" },
    expectedHead: "HEAD",
    targetRoot,
    gitPath,
    graphifyPath,
    graphifyVersion: "0.9.25",
    indexSchemaVersion: "1",
    scratchRoot,
    cacheRoot: join(scratchRoot, "cache"),
    ...overrides,
  };
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ck-graphify-target-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  return dir;
}

test("buildGraphifyEnv is credential-free", () => {
  const env = buildGraphifyEnv({ home: "/tmp/g-home", xdgConfig: "/tmp/g-xdg", tmpdir: "/tmp/g-tmp" });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.MCP_CONFIG, undefined);
  assert.equal(env.PYTHONNOUSERSITE, "1");
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(env.HOME, "/tmp/g-home");
});

test("runGraphify produces a graph outside the target using node-link schema", async () => {
  const target = makeRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ck-graphify-scratch-"));
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", target);
  const projectionRoot = await materializeProjection(manifest, target, scratch);

  const result = await runGraphify(baseRequest(target, scratch), projectionRoot);

  assert.ok(existsSync(result.graphPath));
  assert.ok(resolve(result.graphPath).startsWith(realpathSync(scratch)));
  assert.ok(!resolve(result.graphPath).startsWith(realpathSync(target)));
  const graph = await readGraphifyGraph(result.graphPath) as { nodes: unknown[]; links: unknown[] };
  assert.ok(Array.isArray(graph.nodes));
  assert.ok(Array.isArray(graph.links));
  assert.ok(graph.nodes.length >= 1);
});

test("runGraphify rejects non-absolute graphify path", async () => {
  await assert.rejects(
    () => runGraphify(baseRequest("/tmp", "/tmp", { graphifyPath: "graphify" }), "/tmp"),
    /absolute/,
  );
});

test("runGraphify rejects symlinked graphify path", async () => {
  const target = makeRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ck-graphify-symlink-"));
  const symlink = join(scratch, "graphify-symlink");
  symlinkSync(graphifyPath, symlink);
  await assert.rejects(
    () => runGraphify(baseRequest(target, scratch, { graphifyPath: symlink }), scratch),
    /symlink/,
  );
});

test("runGraphify rejects version mismatch", async () => {
  const target = makeRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ck-graphify-badver-"));
  await assert.rejects(
    () => runGraphify(baseRequest(target, scratch, { graphifyVersion: "0.0.0" }), scratch),
    /version mismatch/,
  );
});
