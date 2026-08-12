/**
 * Per-attempt resource allocation.
 *
 * Every attempt receives unique, never-reused workspace, repository sandbox,
 * private Pi runtime/session roots, actor context, nonce, and result identity.
 * Bounded cleanup removes raw sessions and mutable workspaces after verification
 * or terminal failure, including externally supplied fixture workspaces.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import crypto from 'node:crypto';
import {
  allocateBrokerSocket,
  DEFAULT_SOCKET_BYTE_BUDGET,
  resolveShortSocketRoot,
} from './broker-socket.ts';
import { prepareWorkspaceForSandbox } from './sandbox-identity.ts';

export type ResourceFactoryOptions = {
  readonly runtimeRoot: string;
  readonly cleanupDeadlineMs?: number;
  /**
   * Launcher-owned short broker socket root. When provided, every attempt
   * receives a short, per-attempt, collision-resistant broker socket path under
   * this root (validated realpath/ownership/symlink/byte-length). This keeps
   * broker socket paths under the macOS AF_UNIX limit even when `runtimeRoot`
   * is a long realpath-expanded user temp dir. When omitted, no broker socket is
   * allocated (preserving single-attempt Stage 1 behavior).
   */
  readonly socketRoot?: string;
  /** Maximum broker socket path byte length, inclusive. */
  readonly socketByteBudget?: number;
};

export type AttemptResources = {
  readonly attemptId: string;
  readonly basePath: string;
  readonly workspacePath: string;
  readonly piRuntimeParent: string;
  readonly piSessionDir: string;
  /** In-container HOME path, not a host path. */
  readonly workspaceHome: string;
  readonly workspaceXdgConfig: string;
  readonly workspaceXdgCache: string;
  readonly workspaceXdgData: string;
  readonly nonce: string;
  readonly resultId: string;
  readonly createdAt: Date;
  /**
   * Short launcher-owned broker socket path (AF_UNIX-safe). Set only when the
   * factory was constructed with `socketRoot`; otherwise undefined.
   */
  readonly brokerSocketPath?: string;
  /** Owner-only allocation directory backing {@link brokerSocketPath}. */
  readonly brokerSocketDir?: string;
};

export type CleanupDisposition = {
  readonly attemptRootRemoved: boolean;
  readonly workspaceRemoved: boolean;
  readonly errors: readonly string[];
  /** Whether the launcher-owned broker socket directory was removed on release. */
  readonly brokerSocketRemoved?: boolean;
};

export type ResourceFactory = {
  readonly allocate: (attemptId: string, workspacePath?: string) => AttemptResources;
  readonly release: (resources: AttemptResources) => CleanupDisposition;
};

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(16).toString('hex')}`;
}

export function createAttemptResourceFactory(options: ResourceFactoryOptions): ResourceFactory {
  const runtimeRoot = resolve(options.runtimeRoot);
  ensureDir(runtimeRoot);

  // Resolve the short broker socket root once (eager validation). When the
  // caller does not opt in, broker sockets are not allocated.
  const socketRootReal = options.socketRoot !== undefined ? resolveShortSocketRoot(options.socketRoot) : undefined;
  const socketByteBudget = options.socketByteBudget ?? DEFAULT_SOCKET_BYTE_BUDGET;

  const active = new Map<string, AttemptResources>();
  const released = new Set<string>();

  return {
    allocate(attemptId: string, providedWorkspacePath?: string): AttemptResources {
      const base = mkdtempSync(join(runtimeRoot, 'attempt-'));
      const workspacePath = providedWorkspacePath ? ensureDir(providedWorkspacePath) : ensureDir(join(base, 'workspace'));
      prepareWorkspaceForSandbox(workspacePath);
      const piRuntimeParent = ensureDir(join(base, 'pi-runtime'));
      const piSessionDir = ensureDir(join(piRuntimeParent, makeId('session')));
      const nonce = crypto.randomBytes(32).toString('hex');
      const resultId = makeId('result');

      // Allocate a short broker socket bound to this attempt. The socket lives
      // outside the (possibly long) runtime root so it stays AF_UNIX-safe.
      const broker = socketRootReal !== undefined
        ? allocateBrokerSocket({ attemptId, socketRoot: socketRootReal, byteBudget: socketByteBudget })
        : undefined;

      const resources: AttemptResources = Object.freeze({
        attemptId,
        basePath: base,
        workspacePath,
        piRuntimeParent,
        piSessionDir,
        workspaceHome: '/workspace/.home',
        workspaceXdgConfig: '/workspace/.home/.config',
        workspaceXdgCache: '/workspace/.home/.cache',
        workspaceXdgData: '/workspace/.home/.local/share',
        nonce,
        resultId,
        createdAt: new Date(),
        brokerSocketPath: broker?.socketPath,
        brokerSocketDir: broker?.socketDir,
      });
      active.set(attemptId, resources);
      return resources;
    },

    release(resources: AttemptResources): CleanupDisposition {
      if (released.has(resources.attemptId)) {
        return { attemptRootRemoved: false, workspaceRemoved: false, errors: [`already released: ${resources.attemptId}`] };
      }
      released.add(resources.attemptId);
      active.delete(resources.attemptId);

      const errors: string[] = [];
      const tryRemove = (path: string) => {
        try {
          rmSync(path, { recursive: true, force: true, maxRetries: 2 });
          return true;
        } catch (e) {
          errors.push(`${path}: ${String(e)}`);
          return false;
        }
      };

      // Remove the Pi session/runtime first, then the unique attempt root.
      // If the workspace was externally supplied, remove it exactly once.
      // Remove the launcher-owned broker socket directory (it lives outside the
      // attempt root under the short broker root, so it is not covered above).
      tryRemove(resources.piSessionDir);
      tryRemove(resources.piRuntimeParent);
      const workspaceRemoved = tryRemove(resources.workspacePath);
      const attemptRootRemoved = tryRemove(resources.basePath);
      const brokerSocketRemoved = resources.brokerSocketDir
        ? tryRemove(resources.brokerSocketDir)
        : undefined;

      return { attemptRootRemoved, workspaceRemoved, errors, brokerSocketRemoved };
    },
  };
}
