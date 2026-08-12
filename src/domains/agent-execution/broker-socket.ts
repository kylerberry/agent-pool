/**
 * Launcher-owned short broker socket allocator.
 *
 * macOS AF_UNIX `sun_path` is bounded at ~104 bytes (`AF_UNIX_PATH_LIMIT`).
 * The per-attempt runtime roots are realpath-expanded user temp directories
 * (e.g. `/private/var/folders/…/T`); nesting the broker socket under
 * `<runtimeRoot>/…/pi-runtime/broker.sock` produces paths well over the limit,
 * so the sandbox broker's `listen` fails with `EINVAL` before any Worker starts.
 *
 * This allocator owns a short, per-attempt, collision-resistant socket
 * directory under a launcher-owned short temp root (default `realpath('/tmp')`).
 * It never accepts caller-controlled traversal: only a fixed short root is
 * honored, an owner-only directory is created inside it via `mkdtemp`, and the
 * result is validated for realpath containment, process ownership, restrictive
 * mode, and path byte length before it is handed to the broker. Allocation is
 * bound to an attempt id and removed with verified attempt/run cleanup.
 *
 * Abstract sockets are deliberately not used: they are not portable to macOS.
 */

import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

/** Conservative macOS AF_UNIX `sun_path` byte limit. */
export const AF_UNIX_PATH_LIMIT = 104;

/**
 * Maximum byte length of a resolved broker socket path, inclusive. Leaves
 * headroom under {@link AF_UNIX_PATH_LIMIT} for the socket file name.
 */
export const DEFAULT_SOCKET_BYTE_BUDGET = 96;

/** Short socket file name inside the owner-only allocation directory. */
const SHORT_SOCKET_NAME = 'b.sock';

/** Bounded `mkdtemp` prefix. `mkdtemp` appends six random bytes. */
const SHORT_DIR_PREFIX = 'ap';

export type BrokerSocketAllocation = {
  /** Absolute realpath of the owner-only allocation directory. */
  readonly socketDir: string;
  /** `socketDir` + '/' + short socket file name. Never realpath-resolved. */
  readonly socketPath: string;
};

export type BrokerSocketAllocationOptions = {
  /** Attempt id the allocation is bound to (auditability only). */
  readonly attemptId: string;
  /**
   * Fixed launcher-owned short root. Must be absolute. Defaults to
   * `realpath('/tmp')`. Never accepts a caller-supplied workspace or report
   * path.
   */
  readonly socketRoot?: string;
  /** Maximum socket path byte length, inclusive. Defaults to {@link DEFAULT_SOCKET_BYTE_BUDGET}. */
  readonly byteBudget?: number;
};

class BrokerSocketAllocationError extends Error {
  readonly code:
    | 'BROKER_SOCKET_ROOT_TRAVERSAL'
    | 'BROKER_SOCKET_ROOT_NOT_DIR'
    | 'BROKER_SOCKET_DIR_TRAVERSAL'
    | 'BROKER_SOCKET_PATH_TOO_LONG';
  constructor(
    code:
      | 'BROKER_SOCKET_ROOT_TRAVERSAL'
      | 'BROKER_SOCKET_ROOT_NOT_DIR'
      | 'BROKER_SOCKET_DIR_TRAVERSAL'
      | 'BROKER_SOCKET_PATH_TOO_LONG',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BrokerSocketAllocationError';
    this.code = code;
    // Restore prototype chain for instanceof checks after the super() call.
    Object.setPrototypeOf(this, BrokerSocketAllocationError.prototype);
  }
}

function isProcessOwned(stat: { uid: number }): boolean {
  if (process.getuid === undefined) return true; // Non-POSIX (Windows): skip.
  return stat.uid === process.getuid();
}

/**
 * Validate and realpath-resolve the fixed launcher-owned short root.
 *
 * Rejects relative paths, NUL bytes, and non-directories so a caller cannot
 * steer allocation outside the trusted short root. The resolved path is always
 * absolute and concrete.
 */
export function resolveShortSocketRoot(socketRoot?: string): string {
  const candidate = socketRoot ?? '/tmp';
  if (candidate.includes('\u0000')) {
    throw new BrokerSocketAllocationError(
      'BROKER_SOCKET_ROOT_TRAVERSAL',
      'socket root contains a NUL byte',
    );
  }
  if (!isAbsolute(candidate)) {
    throw new BrokerSocketAllocationError(
      'BROKER_SOCKET_ROOT_TRAVERSAL',
      'socket root must be absolute',
    );
  }
  if (!existsSync(candidate)) {
    throw new BrokerSocketAllocationError(
      'BROKER_SOCKET_ROOT_NOT_DIR',
      `socket root does not exist: ${candidate}`,
    );
  }
  const stat = statSync(candidate);
  if (!stat.isDirectory()) {
    throw new BrokerSocketAllocationError(
      'BROKER_SOCKET_ROOT_NOT_DIR',
      `socket root is not a directory: ${candidate}`,
    );
  }
  // realpath resolves any symlink on the root itself to a concrete absolute path.
  return realpathSync(candidate);
}

/**
 * Allocate a short, per-attempt, collision-resistant broker socket path.
 *
 * Creates an owner-only `mkdtemp` directory inside the validated short root,
 * chmods it to `0o700`, then asserts: the realpath of the created directory
 * stays inside the root realpath (symlink-escape defense), the directory is
 * owned by the current process, and the resolved socket path is within the byte
 * budget. On any validation failure the freshly created directory is removed
 * before throwing, so a failed allocation leaks nothing.
 */
export function allocateBrokerSocket(options: BrokerSocketAllocationOptions): BrokerSocketAllocation {
  const budget = options.byteBudget ?? DEFAULT_SOCKET_BYTE_BUDGET;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new BrokerSocketAllocationError(
      'BROKER_SOCKET_PATH_TOO_LONG',
      `byte budget must be a positive integer, got ${String(budget)}`,
    );
  }

  const rootReal = resolveShortSocketRoot(options.socketRoot);

  // Atomic, collision-resistant directory creation inside the trusted root.
  const createdDir = mkdtempSync(join(rootReal, SHORT_DIR_PREFIX));
  try {
    chmodSync(createdDir, 0o700);

    // Containment check: the realpath of the created directory must stay within
    // the root realpath. `relative` yields a path with no leading `..` only when
    // the target is inside the root.
    const dirReal = realpathSync(createdDir);
    const rel = relative(rootReal, dirReal);
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
      throw new BrokerSocketAllocationError(
        'BROKER_SOCKET_DIR_TRAVERSAL',
        `allocation dir realpath escapes root: ${dirReal} (root ${rootReal})`,
      );
    }

    const dirStat = statSync(dirReal);
    if (!dirStat.isDirectory()) {
      throw new BrokerSocketAllocationError(
        'BROKER_SOCKET_DIR_TRAVERSAL',
        `allocation dir is not a directory: ${dirReal}`,
      );
    }
    if (!isProcessOwned(dirStat)) {
      throw new BrokerSocketAllocationError(
        'BROKER_SOCKET_DIR_TRAVERSAL',
        `allocation dir not owned by process: ${dirReal}`,
      );
    }
    const mode = dirStat.mode & 0o777;
    if (mode !== 0o700) {
      throw new BrokerSocketAllocationError(
        'BROKER_SOCKET_DIR_TRAVERSAL',
        `allocation dir not owner-only (mode 0o${mode.toString(8)}): ${dirReal}`,
      );
    }

    const socketPath = join(dirReal, SHORT_SOCKET_NAME);
    if (Buffer.byteLength(socketPath, 'utf8') > budget) {
      throw new BrokerSocketAllocationError(
        'BROKER_SOCKET_PATH_TOO_LONG',
        `socket path ${socketPath} (${Buffer.byteLength(socketPath)} bytes) exceeds budget ${budget}`,
      );
    }

    return Object.freeze({ socketDir: dirReal, socketPath });
  } catch (err) {
    // Never leave a partial allocation directory behind on failure.
    rmSync(createdDir, { recursive: true, force: true });
    throw err;
  }
}
