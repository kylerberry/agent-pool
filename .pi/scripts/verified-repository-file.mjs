import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function fail(message) { throw new Error(message); }

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

// Governing repository inputs must be root-contained regular files. Symlinks are rejected in the
// final component and every existing ancestor before opening (O_NOFOLLOW), and the opened
// descriptor is re-validated after the open: the ancestor/final symlink check is repeated, the
// target's realpath must remain the exact expected root-contained path, and the current path's
// device and inode must match the opened descriptor. Bytes are read and hashed only from the
// verified descriptor.
export function readVerifiedRepositoryFile(root, relative, { label = "repository file", maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative)) fail(`${label} path is invalid: ${relative}`);
  const rootDir = fs.realpathSync(path.resolve(root));
  const target = path.resolve(rootDir, relative);
  if (!isWithin(rootDir, target)) fail(`${label} escapes repository root: ${relative}`);
  const segments = path.relative(rootDir, target).split(path.sep).filter((item) => item && item !== ".");
  const assertNoSymlinks = () => {
    let current = rootDir;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stats;
      try { stats = fs.lstatSync(current); } catch { fail(`${label} is missing: ${relative}`); }
      if (stats.isSymbolicLink()) fail(`${label} path contains a symbolic link: ${current}`);
    }
  };
  assertNoSymlinks();
  const descriptor = (() => {
    try { return fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
    catch { fail(`${label} is missing: ${relative}`); }
  })();
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) fail(`${label} is not a regular file: ${relative}`);
    if (stats.size > maxBytes) fail(`${label} exceeds size bound`);
    // Post-open validation closes the check/open race: while the descriptor stays open, the
    // path must still be symlink-free and resolve to exactly the expected root-contained file.
    assertNoSymlinks();
    let resolved;
    try { resolved = fs.realpathSync(target); } catch { fail(`${label} path could not be resolved: ${relative}`); }
    if (resolved !== path.resolve(rootDir, relative)) fail(`${label} resolved outside the expected root-contained path: ${relative}`);
    let currentStats;
    try { currentStats = fs.statSync(target); } catch { fail(`${label} is missing: ${relative}`); }
    if (currentStats.dev !== stats.dev || currentStats.ino !== stats.ino) fail(`${label} path no longer references the opened file: ${relative}`);
    const fileBytes = fs.readFileSync(descriptor);
    if (fileBytes.length > maxBytes) fail(`${label} exceeds size bound`);
    return { bytes: fileBytes, sha256: crypto.createHash("sha256").update(fileBytes).digest("hex") };
  } finally { fs.closeSync(descriptor); }
}

export function readVerifiedRepositoryJson(root, relative, options = {}) {
  const { bytes, sha256 } = readVerifiedRepositoryFile(root, relative, options);
  let value;
  try { value = JSON.parse(bytes); } catch (error) { fail(`${options.label || "repository file"} JSON parse error: ${error.message}`); }
  return { value, bytes, sha256 };
}
