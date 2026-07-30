import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  resolveHead,
  resolveStatus,
  buildGitEnv,
  captureManifest,
  normalizeRelativePath,
  manifestDigest,
  isOutsideTarget,
} from "../../src/domains/codebase-knowledge/target-repository.ts";

const gitPath = realpathSync(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());

function makeRepo(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `ck-git-${name}-`));
  const run = (cmd: string, ...args: string[]) => {
    const result = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr}`);
    return result;
  };
  run("git", "init");
  run("git", "config", "user.email", "test@example.com");
  run("git", "config", "user.name", "Test");
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  run("git", "add", ".");
  run("git", "commit", "-m", "initial");
  return dir;
}

test("resolveHead returns a full SHA", async () => {
  const repo = makeRepo("head");
  const head = await resolveHead(gitPath, repo);
  assert.match(head, /^[0-9a-f]{40}$/);
});

test("resolveStatus returns clean for committed repo", async () => {
  const repo = makeRepo("status");
  const status = await resolveStatus(gitPath, repo);
  assert.equal(status.clean, true);
  assert.equal(status.entries.length, 0);
});

test("resolveHead rejects non-absolute git path", async () => {
  const repo = makeRepo("abs-git");
  await assert.rejects(() => resolveHead("git", repo), /absolute/);
});

test("resolveHead rejects symlinked git path", async () => {
  const repo = makeRepo("symlink-git");
  const symlink = join(repo, "git-symlink");
  symlinkSync(gitPath, symlink);
  await assert.rejects(() => resolveHead(symlink, repo), /symlink/);
});

test("buildGitEnv is credential-free", () => {
  const env = buildGitEnv();
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.credential_helper, undefined);
});

test("normalizeRelativePath rejects traversal", () => {
  assert.equal(normalizeRelativePath("src/a.js"), "src/a.js");
  assert.throws(() => normalizeRelativePath("../a.js"), /outside target root/);
  assert.throws(() => normalizeRelativePath("/abs"), /absolute/);
});

test("captureManifest includes regular files only", async () => {
  const repo = makeRepo("manifest");
  const manifest = await captureManifest({ owner: "o", name: "n" }, "HEAD", repo);
  assert.ok(manifest.entries.some((e) => e.relativePath === "a.js"));
  assert.ok(manifest.digest.startsWith("sha256:"));
});

test("captureManifest excludes symlinks and directories", async () => {
  const repo = makeRepo("symlink");
  symlinkSync(join(repo, "a.js"), join(repo, "link.js"));
  mkdirSync(join(repo, "empty"));
  const manifest = await captureManifest({ owner: "o", name: "n" }, "HEAD", repo);
  assert.equal(manifest.entries.some((e) => e.relativePath === "link.js"), false);
  assert.equal(manifest.entries.some((e) => e.relativePath === "empty"), false);
});

test("manifestDigest is stable", () => {
  const entries = [
    { relativePath: "b.js", type: "file" as const, mode: 0o644, size: 1, digest: "sha256:d1" },
    { relativePath: "a.js", type: "file" as const, mode: 0o644, size: 1, digest: "sha256:d2" },
  ];
  const d1 = manifestDigest(entries);
  const d2 = manifestDigest([...entries].reverse());
  assert.equal(d1, d2);
});

test("isOutsideTarget distinguishes inside and outside", () => {
  assert.equal(isOutsideTarget("/target", "/target/cache"), false);
  assert.equal(isOutsideTarget("/target", "/target"), false);
  assert.equal(isOutsideTarget("/target", "/cache"), true);
  assert.equal(isOutsideTarget("/target", "/targetfoo"), true);
});
