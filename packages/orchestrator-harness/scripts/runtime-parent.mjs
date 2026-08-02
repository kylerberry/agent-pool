/**
 * Launcher-owned private runtime parent.
 *
 * Creates a fresh atomically-named parent directory under a canonical runtime
 * base that is independent of caller-controlled temporary-directory
 * environment variables, validates ownership, directory type, permissions and
 * realpath containment, and provides whole-subtree cleanup restricted to the
 * launcher-created path.
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  lstatSync,
  realpathSync,
  existsSync,
  chmodSync as fsChmodSync,
} from "node:fs";
import { join, resolve, isAbsolute, basename } from "node:path";

// Canonical runtime base independent of inherited TMPDIR/TEMP/TMP.
const RUNTIME_BASE = resolve("/tmp");
const DIR_MODE = 0o700;
const RUNTIME_PREFIX = "agent-pool-orch-runtime-";

function getUid() {
  try {
    return process.getuid?.();
  } catch {
    return undefined;
  }
}

function assertRegularDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`runtime path is not a directory: ${path}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`runtime path must not be a symlink: ${path}`);
  }
  return stat;
}

function assertOwnedByUs(stat, path) {
  const uid = getUid();
  if (uid !== undefined && stat.uid !== 0 && stat.uid !== uid) {
    throw new Error(`runtime path is not owned by root or launcher: ${path}`);
  }
}

function validateRuntimeBase() {
  if (!isAbsolute(RUNTIME_BASE)) {
    throw new Error("runtime base must be absolute");
  }
  if (!existsSync(RUNTIME_BASE)) {
    throw new Error("runtime base does not exist");
  }
  const realBase = realpathSync(RUNTIME_BASE);
  const stat = assertRegularDirectory(realBase);
  assertOwnedByUs(stat, realBase);

  const mode = stat.mode & 0o7777;
  // World-writable directories are acceptable only with the sticky bit set
  // (e.g. /tmp), which prevents non-owners from removing each other's entries.
  if ((mode & 0o002) && !(mode & 0o1000)) {
    throw new Error(`runtime base is world-writable without sticky bit: ${realBase}`);
  }
  return realBase;
}

function assertContained(parent, path) {
  const realParent = realpathSync(parent);
  const realPath = realpathSync(path);
  const prefix = realParent.endsWith("/") ? realParent : `${realParent}/`;
  if (realPath !== realParent && !realPath.startsWith(prefix)) {
    throw new Error(`runtime child is not contained in parent: ${realPath}`);
  }
}

export function createRuntimeParent() {
  const base = validateRuntimeBase();
  mkdirSync(base, { recursive: true, mode: DIR_MODE });
  const parent = mkdtempSync(join(base, RUNTIME_PREFIX));
  mkdirSync(parent, { recursive: true, mode: DIR_MODE });
  fsChmodSync(parent, DIR_MODE);

  const realParent = realpathSync(parent);
  const stat = assertRegularDirectory(realParent);
  assertOwnedByUs(stat, realParent);
  assertContained(base, realParent);

  const home = join(realParent, "home");
  const xdg = join(realParent, "xdg");
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  mkdirSync(xdg, { recursive: true, mode: DIR_MODE });

  assertContained(realParent, home);
  assertContained(realParent, xdg);

  return Object.freeze({
    path: realParent,
    home,
    xdg,
    mode: DIR_MODE,
  });
}

export function cleanupRuntimeParent(parentPath) {
  if (!parentPath || typeof parentPath !== "string") {
    return;
  }
  if (!isAbsolute(parentPath)) {
    return;
  }
  const base = basename(parentPath);
  if (!base.startsWith(RUNTIME_PREFIX)) {
    return;
  }

  let realBase;
  let realParent;
  try {
    realBase = validateRuntimeBase();
    realParent = realpathSync(parentPath);
  } catch {
    return;
  }
  const basePrefix = realBase.endsWith("/") ? realBase : `${realBase}/`;
  if (!realParent.startsWith(basePrefix)) {
    return;
  }
  if (!basename(realParent).startsWith(RUNTIME_PREFIX)) {
    return;
  }
  try {
    rmSync(parentPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}
