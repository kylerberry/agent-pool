import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function createCopiedPackageFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-pool-worker-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }));
  const packagePath = join(root, "package");
  cpSync(packageRoot, packagePath, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((part) => part === "node_modules" || part === ".git" || part === "test-output"),
  });
  return { root, packagePath, script: join(packagePath, "scripts", "preflight.mjs") };
}
