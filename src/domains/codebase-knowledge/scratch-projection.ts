import { mkdir, lstat, readFile } from "node:fs/promises";
import { resolve, join, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";
import { normalizeRelativePath } from "./target-repository.ts";
import { copyFileNoFollow, resolveRealAbsolutePath, isOutsideResolvedRoot } from "./path-safety.ts";
import type { SourceManifest, SensitivePathPolicy, ManifestEntry } from "./contracts.ts";
import { DEFAULT_SENSITIVE_PATH_POLICY, isSensitivePath } from "./contracts.ts";

async function rejectIfSymlink(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) throw new Error("path must not be a symlink");
}

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs",
  ".ts", ".mts", ".cts",
  ".jsx", ".tsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".fs", ".swift",
  ".php", ".scala", ".clj",
]);

const EXCLUDED_NAMES = new Set([
  ".env", ".env.local", ".env.production", ".env.development",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

export function isStructuralCodeFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const base = normalized.split("/").pop() || "";
  if (EXCLUDED_NAMES.has(base)) return false;
  const ext = base.lastIndexOf(".");
  if (ext <= 0) return false;
  return CODE_EXTENSIONS.has(base.slice(ext));
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}

export interface MaterializeOptions {
  policy?: SensitivePathPolicy;
}

export async function materializeProjection(
  manifest: SourceManifest,
  sourceRoot: string,
  scratchRoot: string,
  options: MaterializeOptions = {},
): Promise<string> {
  if (!isAbsolute(sourceRoot)) throw new Error("source root must be absolute");
  if (!isAbsolute(scratchRoot)) throw new Error("scratch root must be absolute");
  await rejectIfSymlink(scratchRoot);
  const sourceReal = await resolveRealAbsolutePath(sourceRoot);
  const scratchReal = await resolveRealAbsolutePath(scratchRoot);
  if (!isOutsideResolvedRoot(sourceReal, scratchReal)) {
    throw new Error("scratch root must be outside target repository");
  }
  const projectionRoot = join(scratchReal, "projection");
  await mkdir(projectionRoot, { recursive: true });

  const policy = options.policy ?? DEFAULT_SENSITIVE_PATH_POLICY;

  for (const entry of manifest.entries) {
    if (!isStructuralCodeFile(entry.relativePath)) continue;
    if (isSensitivePath(entry.relativePath, policy)) continue;

    const sourcePath = join(sourceReal, entry.relativePath);
    const targetPath = join(projectionRoot, entry.relativePath);

    // Containment check against the real source root.
    if (isOutsideResolvedRoot(sourceReal, sourcePath)) {
      throw new Error(`source path escapes target root: ${entry.relativePath}`);
    }

    // Re-validate the source is a regular file (not a symlink) before copying.
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error(`projection source is not a regular file: ${entry.relativePath}`);
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await copyFileNoFollow(sourcePath, targetPath, sourceInfo.mode & 0o777);
    const copied = await lstat(targetPath);
    if (!copied.isFile()) throw new Error(`projection entry is not a regular file: ${entry.relativePath}`);
    const actualDigest = await digestOf(targetPath);
    if (actualDigest !== entry.digest) {
      throw new Error(`digest mismatch for ${entry.relativePath}: expected ${entry.digest}, got ${actualDigest}`);
    }
  }

  return projectionRoot;
}

export function filterSensitiveEntries(entries: ManifestEntry[], policy?: SensitivePathPolicy): ManifestEntry[] {
  const p = policy ?? DEFAULT_SENSITIVE_PATH_POLICY;
  return entries.filter((e) => !isSensitivePath(e.relativePath, p));
}
