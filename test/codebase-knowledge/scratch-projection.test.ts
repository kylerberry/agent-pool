import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureManifest } from "../../src/domains/codebase-knowledge/target-repository.ts";
import { materializeProjection, isStructuralCodeFile } from "../../src/domains/codebase-knowledge/scratch-projection.ts";
import { DEFAULT_SENSITIVE_PATH_POLICY, isSensitivePath } from "../../src/domains/codebase-knowledge/contracts.ts";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ck-proj-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "credentials.js"), "export const secret = 1;\n");
  return dir;
}

test("isStructuralCodeFile accepts code files and rejects lockfiles", () => {
  assert.equal(isStructuralCodeFile("src/a.js"), true);
  assert.equal(isStructuralCodeFile("package-lock.json"), false);
  assert.equal(isStructuralCodeFile(".env"), false);
});

test("isSensitivePath matches controller policy patterns", () => {
  assert.equal(isSensitivePath("src/credentials.js", DEFAULT_SENSITIVE_PATH_POLICY), true);
  assert.equal(isSensitivePath(".env.local", DEFAULT_SENSITIVE_PATH_POLICY), true);
  assert.equal(isSensitivePath("src/a.js", DEFAULT_SENSITIVE_PATH_POLICY), false);
  assert.equal(isSensitivePath("docs/key-rotation.md", DEFAULT_SENSITIVE_PATH_POLICY), true);
});

test("materializeProjection excludes sensitive paths", async () => {
  const repo = makeRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ck-proj-scratch-"));
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", repo);
  const projectionRoot = await materializeProjection(manifest, repo, scratch);
  assert.equal(existsSync(join(projectionRoot, "src", "a.js")), true);
  assert.equal(existsSync(join(projectionRoot, "src", "credentials.js")), false);
});

test("materializeProjection rejects symlinked scratch root", async () => {
  const repo = makeRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ck-proj-scratch-"));
  const symlinkedScratch = join(repo, "symlinked-scratch");
  symlinkSync(scratch, symlinkedScratch);
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", repo);
  await assert.rejects(
    () => materializeProjection(manifest, repo, symlinkedScratch),
    /path must not be a symlink|outside target repository/,
  );
});

test("materializeProjection fails closed on post-manifest symlink swap", async () => {
  const repo = makeRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ck-proj-swap-"));
  const manifest = await captureManifest({ owner: "o", name: "r" }, "HEAD", repo);

  // Replace a regular file with a symlink after manifest capture.
  const original = join(repo, "src", "a.js");
  rmSync(original);
  symlinkSync(join(repo, "src", "credentials.js"), original);

  await assert.rejects(
    () => materializeProjection(manifest, repo, scratch),
    /not a regular file/,
  );
});
