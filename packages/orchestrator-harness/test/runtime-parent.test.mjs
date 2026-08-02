import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("creates a private runtime parent with HOME and XDG beneath it", async () => {
  const { createRuntimeParent } = await import(join(packageRoot, "scripts/runtime-parent.mjs"));
  const runtime = createRuntimeParent();
  assert.ok(existsSync(runtime.path), "runtime parent missing");
  assert.ok(existsSync(runtime.home), "HOME missing");
  assert.ok(existsSync(runtime.xdg), "XDG missing");
  assert.ok(runtime.home.startsWith(runtime.path), "HOME not under parent");
  assert.ok(runtime.xdg.startsWith(runtime.path), "XDG not under parent");
});

test("cleanup removes the whole runtime subtree and refuses external paths", async () => {
  const { createRuntimeParent, cleanupRuntimeParent } = await import(join(packageRoot, "scripts/runtime-parent.mjs"));
  const runtime = createRuntimeParent();
  const childFile = join(runtime.home, "child.txt");
  writeFileSync(childFile, "data");
  assert.ok(existsSync(childFile));

  cleanupRuntimeParent(runtime.path);
  assert.ok(!existsSync(runtime.path), "runtime parent not removed");

  // Refuses to clean paths that do not match the launcher-created prefix.
  const external = mkdtempSync(join(tmpdir(), "agent-pool-external-"));
  cleanupRuntimeParent(external);
  assert.ok(existsSync(external), "external path was wrongly removed");
});

test("cleanup refuses symlinked or non-absolute paths", async () => {
  const { cleanupRuntimeParent } = await import(join(packageRoot, "scripts/runtime-parent.mjs"));
  const external = mkdtempSync(join(tmpdir(), "agent-pool-external-"));
  const symlink = join(tmpdir(), `agent-pool-symlink-${Date.now()}`);
  symlinkSync(external, symlink);
  cleanupRuntimeParent(symlink);
  assert.ok(existsSync(external), "symlink target was wrongly removed");
});
