/**
 * Pi executable identity verification.
 *
 * Canonicalizes the launcher path, rejects symlinks and non-regular files,
 * verifies the pinned sha256 digest from launcher bytes *before* executing the
 * file, then verifies the pinned version, and returns an immutable identity
 * record. All verification is synchronous and uses only the trusted absolute
 * interpreter.
 */

import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const EXPECTED_VERSION = "0.81.1";

function normalizeDigest(digest) {
  if (!digest) return "";
  return String(digest).replace(/^sha256:/, "");
}

export function verifyPiIdentity(launcherPath, trustedInterpreter, expectedDigest) {
  if (!launcherPath || typeof launcherPath !== "string") {
    throw new Error("Pi launcher path is required");
  }
  if (!isAbsolute(launcherPath)) {
    throw new Error("Pi launcher path must be absolute");
  }
  if (!trustedInterpreter || !isAbsolute(trustedInterpreter)) {
    throw new Error("trusted interpreter must be an absolute path");
  }

  const initialStat = lstatSync(launcherPath);
  if (!initialStat.isFile()) {
    throw new Error(`Pi launcher is not a regular file: ${launcherPath}`);
  }
  if (initialStat.isSymbolicLink()) {
    throw new Error(`Pi launcher must not be a symlink: ${launcherPath}`);
  }

  let canonicalPath;
  try {
    canonicalPath = realpathSync(launcherPath);
  } catch {
    throw new Error(`Pi launcher canonical path resolution failed: ${launcherPath}`);
  }

  const stat = lstatSync(canonicalPath);
  if (!stat.isFile()) {
    throw new Error(`Pi launcher is not a regular file: ${canonicalPath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Pi launcher must not be a symlink: ${canonicalPath}`);
  }

  // Hash the pinned bytes and compare the digest before any execution.
  const bytes = readFileSync(canonicalPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const expected = normalizeDigest(expectedDigest);
  if (!expected) {
    throw new Error("Pi launcher expected digest is required");
  }
  if (digest !== expected) {
    throw new Error(`Pi digest mismatch: expected sha256:${expected}, got sha256:${digest}`);
  }

  const versionResult = spawnSync(trustedInterpreter, [canonicalPath, "--version"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  const versionMatch = /pi\s+v?(\d+\.\d+\.\d+)/.exec(versionResult.stdout.trim());
  if (!versionMatch || versionMatch[1] !== EXPECTED_VERSION) {
    throw new Error(`Pi version mismatch: expected ${EXPECTED_VERSION}, got ${versionMatch?.[1] ?? "unknown"}`);
  }

  return Object.freeze({
    path: canonicalPath,
    canonicalPath,
    version: EXPECTED_VERSION,
    digest: `sha256:${digest}`,
    bytes,
  });
}
