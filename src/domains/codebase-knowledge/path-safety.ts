/**
 * Path safety and executable provenance helpers.
 *
 * All repository, scratch, and cache roots are resolved through realpath
 * so symlinked roots cannot bypass lexical containment checks. Executable
 * paths must be absolute, exist, and not be symlinks (caller-controlled or
 * otherwise).
 */

import { constants } from "node:fs";
import { lstat, realpath, open, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve, dirname } from "node:path";

export { constants };

export interface ResolvedRoot {
  requested: string;
  real: string;
}

/**
 * Resolve an absolute path and follow symlinks to the real path.
 * Rejects if the path is not absolute or does not exist.
 */
export async function resolveRealAbsolutePath(raw: string): Promise<string> {
  if (typeof raw !== "string" || raw === "") throw new Error("path is required");
  if (!isAbsolute(raw)) throw new Error("path must be absolute");
  try {
    return await realpath(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("path does not exist");
    throw err;
  }
}

/**
 * Return true if `candidate` is outside `root` after realpath resolution.
 * Equal paths are considered inside (not outside).
 */
export async function isOutsideRealRoot(root: string, candidate: string): Promise<boolean> {
  const rootReal = await resolveRealAbsolutePath(root);
  const candidateReal = await resolveRealAbsolutePath(candidate);
  return isOutsideResolvedRoot(rootReal, candidateReal);
}

/**
 * Synchronous realpath-safe containment for paths already known to exist.
 */
export function isOutsideResolvedRoot(rootReal: string, candidateReal: string): boolean {
  if (!isAbsolute(rootReal)) throw new Error("root must be absolute");
  if (!isAbsolute(candidateReal)) throw new Error("candidate must be absolute");
  if (candidateReal === rootReal) return false;
  const prefix = `${rootReal}/`;
  return !candidateReal.startsWith(prefix);
}

/**
 * Validate an executable path: absolute, exists, is a regular file, and is not
 * a symlink itself (so the caller cannot substitute a different binary via a
 * symlink). Parent-directory symlinks are allowed because system paths such as
 * /var commonly use them, but the executable file itself must be a real file.
 */
export async function validateExecutablePath(executablePath: string): Promise<void> {
  if (typeof executablePath !== "string" || executablePath === "") {
    throw new Error("executable path is required");
  }
  if (!isAbsolute(executablePath)) throw new Error("executable path must be absolute");
  let info;
  try {
    info = await lstat(executablePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("executable does not exist");
    throw err;
  }
  if (info.isSymbolicLink()) throw new Error("executable must not be a symlink");
  if (!info.isFile()) throw new Error("executable must be a regular file");
}

/**
 * Read a file without following symlinks. This prevents a manifest-captured
 * regular file from being replaced by a symlink and read as a different target
 * between capture and use.
 */
export async function readFileNoFollow(path: string, encoding?: "utf8"): Promise<Buffer | string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile(encoding);
  } finally {
    await handle.close();
  }
}

/**
 * Copy a regular file without following symlinks on the source. The destination
 * is created as a regular file. Mode defaults to 0o644.
 */
export async function copyFileNoFollow(
  sourcePath: string,
  targetPath: string,
  mode = 0o644,
): Promise<void> {
  const data = await readFileNoFollow(sourcePath);
  const tmp = `${targetPath}.tmp.${randomBytes(8).toString("hex")}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, targetPath);
}
