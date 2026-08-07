/**
 * Launcher-owned sandbox UID/GID mapping.
 *
 * The container must never run as uid 0. When the launcher is a non-root host
 * user, the sandbox runs as that user:group so the bind-mounted workspace is
 * writable. When the launcher is root, the workspace is provisioned and chowned
 * for the pinned non-root sandbox user (1001:1001). The same mapping is used
 * for base-red runs, the broker repository sandbox, verifier fixture runs, and
 * profile documentation.
 */

import { chownSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const SANDBOX_PINNED_UID = 1001;
export const SANDBOX_PINNED_GID = 1001;

export type SandboxIdentity = {
  readonly uid: number;
  readonly gid: number;
  /** True when the host launcher is root and the pinned identity is used. */
  readonly isPinned: boolean;
};

/**
 * Resolve the UID:GID the sandbox container must run as.
 *
 * Non-root launchers use their own host identity so the bind mount is writable.
 * Root launchers fall back to the pinned sandbox identity and the caller is
 * responsible for provisioning/chowning the workspace to that identity.
 */
export function resolveSandboxIdentity(): SandboxIdentity {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('sandbox identity unavailable: process uid/gid are required');
  }
  const hostUid = process.getuid();
  const hostGid = process.getgid();
  if (hostUid === 0) {
    return { uid: SANDBOX_PINNED_UID, gid: SANDBOX_PINNED_GID, isPinned: true };
  }
  return { uid: hostUid, gid: hostGid, isPinned: false };
}

/**
 * Fail closed if a caller ever tries to execute a container as uid 0.
 */
export function requireNonRootSandboxIdentity(identity: SandboxIdentity): void {
  if (identity.uid === 0) {
    throw new Error('sandbox identity rejected: container execution as uid 0 is not permitted');
  }
}

const HOME_DIRS = Object.freeze(['.home', '.home/.config', '.home/.cache', '.home/.local/share']);

function isSafeToChown(path: string): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function chownRecursive(basePath: string, uid: number, gid: number): void {
  if (!isSafeToChown(basePath)) return;
  chownSync(basePath, uid, gid);
  let entries: string[];
  try {
    entries = readdirSync(basePath);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(basePath, entry);
    if (!isSafeToChown(full)) continue;
    chownSync(full, uid, gid);
    try {
      const st = lstatSync(full);
      if (st.isDirectory()) {
        chownRecursive(full, uid, gid);
      }
    } catch {
      // bounded: skip entries we cannot stat
    }
  }
}

/**
 * Prepare a host workspace for the sandbox container.
 *
 * Creates the writable in-workspace HOME/XDG directories and ensures they are
 * owned by the sandbox identity. When the launcher is root, the entire fixture
 * is recursively chowned to the pinned sandbox identity.
 */
export function prepareWorkspaceForSandbox(
  workspacePath: string,
  identity?: SandboxIdentity,
): SandboxIdentity {
  const id = identity ?? resolveSandboxIdentity();
  requireNonRootSandboxIdentity(id);

  for (const dir of HOME_DIRS) {
    const target = resolve(workspacePath, dir);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    if (isSafeToChown(target)) {
      chownSync(target, id.uid, id.gid);
    }
  }

  if (id.isPinned) {
    // The host launcher is root; chown the fixture so the pinned container user
    // can write and Git can compose commits.
    chownRecursive(workspacePath, id.uid, id.gid);
  }

  return id;
}
