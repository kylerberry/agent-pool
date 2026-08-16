import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readVerifiedRepositoryFile, readVerifiedRepositoryJson } from "./verified-repository-file.mjs";

const bytes = (value) => Buffer.from(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

describe("verified repository file reader", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "verified-file-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("reads a regular contained file and returns bytes plus stable SHA-256", () => {
    const target = path.join(root, "docs", "plan.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes("plan-bytes"));
    const result = readVerifiedRepositoryFile(root, "docs/plan.json", { label: "plan" });
    assert.deepEqual(result.bytes, bytes("plan-bytes"));
    assert.equal(result.sha256, sha256(bytes("plan-bytes")));
    assert.equal(readVerifiedRepositoryFile(root, "docs/plan.json", { label: "plan" }).sha256, result.sha256);
  });

  test("parses verified JSON through the same boundary", () => {
    const target = path.join(root, "sidecar.json");
    fs.writeFileSync(target, bytes(`${JSON.stringify({ ok: true }, null, 2)}\n`));
    const { value, bytes: raw } = readVerifiedRepositoryJson(root, "sidecar.json", { label: "sidecar" });
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(raw, bytes(`${JSON.stringify({ ok: true }, null, 2)}\n`));
  });

  test("rejects absolute paths, parent traversal, and empty relative paths", () => {
    fs.writeFileSync(path.join(root, "plan.json"), bytes("x"));
    assert.throws(() => readVerifiedRepositoryFile(root, "/etc/hosts", { label: "plan" }), /path is invalid/);
    assert.throws(() => readVerifiedRepositoryFile(root, "", { label: "plan" }), /path is invalid/);
    assert.throws(() => readVerifiedRepositoryFile(root, "../plan.json", { label: "plan" }), /escapes repository root/);
    assert.throws(() => readVerifiedRepositoryFile(root, "docs/../../plan.json", { label: "plan" }), /escapes repository root|symbolic link/);
  });

  test("rejects missing files and directories", () => {
    assert.throws(() => readVerifiedRepositoryFile(root, "missing.json", { label: "plan" }), /missing/);
    fs.mkdirSync(path.join(root, "adir"));
    assert.throws(() => readVerifiedRepositoryFile(root, "adir", { label: "plan" }), /not a regular file|missing/);
  });

  test("rejects a final-component symlink", () => {
    const real = path.join(root, "real.json");
    fs.writeFileSync(real, bytes("real"));
    fs.symlinkSync(real, path.join(root, "plan.json"));
    assert.throws(() => readVerifiedRepositoryFile(root, "plan.json", { label: "plan" }), /symbolic link/);
  });

  test("rejects an ancestor symlink", () => {
    const realDir = path.join(root, "real-dir");
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "plan.json"), bytes("real"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.symlinkSync(realDir, path.join(root, "docs", "plans"));
    assert.throws(() => readVerifiedRepositoryFile(root, "docs/plans/plan.json", { label: "plan" }), /symbolic link/);
  });

  test("rejects a symlink occupying a path that previously held a regular file", () => {
    const real = path.join(root, "real.json");
    fs.writeFileSync(real, bytes("real"));
    const target = path.join(root, "plan.json");
    fs.writeFileSync(target, bytes("original"));
    // Statically present a path whose final component is a symlink that replaced a regular
    // file; the reader must reject it before opening.
    fs.rmSync(target);
    fs.symlinkSync(real, target);
    assert.throws(() => readVerifiedRepositoryFile(root, "plan.json", { label: "plan" }), /symbolic link/);
  });

  test("rejects oversized files against a custom bound", () => {
    fs.writeFileSync(path.join(root, "big.json"), bytes("x".repeat(65)));
    assert.throws(() => readVerifiedRepositoryFile(root, "big.json", { label: "plan", maxBytes: 64 }), /size bound/);
  });

  test("JSON parse failures surface a labeled error", () => {
    fs.writeFileSync(path.join(root, "bad.json"), bytes("{not json"));
    assert.throws(() => readVerifiedRepositoryJson(root, "bad.json", { label: "sidecar" }), /parse error/);
  });
});
