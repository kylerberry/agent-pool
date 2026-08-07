/**
 * Workspace-confined repository tool adapters.
 *
 * Every read/write/edit/bash request is forwarded to the trusted sandbox broker
 * that executes inside the container. The adapters themselves never open host
 * workspace files.
 */

import type { RepositorySandbox, BrokerResponse } from './repository-sandbox.ts';

export type ToolReadResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type ToolWriteResult =
  | { ok: true }
  | { ok: false; error: string };

export type ToolCommandResult =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; error: string };

export type RepositoryToolAdapters = {
  readonly read: (path: string) => Promise<ToolReadResult>;
  readonly write: (path: string, content: string) => Promise<ToolWriteResult>;
  readonly edit: (path: string, oldText: string, newText: string) => Promise<ToolWriteResult>;
  /** Repository commands receive only the broker-defined allowlist environment. */
  readonly runCommand: (args: readonly string[]) => Promise<ToolCommandResult>;
};

type AdapterOptions = {
  readonly sandbox: RepositorySandbox;
};

const FORBIDDEN_CHARS = /[\u0000-\u001f]/;

function isSafeRelativePath(path: string): boolean {
  if (FORBIDDEN_CHARS.test(path)) return false;
  if (path.startsWith('/')) return false;
  if (path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false;
  const normalized = path.replace(/\\/g, '/');
  return !normalized.split('/').includes('..');
}

export function createRepositoryToolAdapters(options: AdapterOptions): RepositoryToolAdapters {
  const sandbox = options.sandbox;

  async function forward(request: unknown): Promise<BrokerResponse> {
    return sandbox.runTool(request);
  }

  return {
    async read(path: string): Promise<ToolReadResult> {
      if (!isSafeRelativePath(path)) return { ok: false, error: 'path outside workspace' };
      const result = await forward({ tool: 'read', path });
      return result.ok ? { ok: true, content: result.content ?? '' } : { ok: false, error: result.error };
    },

    async write(path: string, content: string): Promise<ToolWriteResult> {
      if (!isSafeRelativePath(path)) return { ok: false, error: 'path outside workspace' };
      const result = await forward({ tool: 'write', path, content });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },

    async edit(path: string, oldText: string, newText: string): Promise<ToolWriteResult> {
      if (!isSafeRelativePath(path)) return { ok: false, error: 'path outside workspace' };
      const result = await forward({ tool: 'edit', path, oldText, newText });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },

    async runCommand(args): Promise<ToolCommandResult> {
      if (args.length === 0) return { ok: false, error: 'empty command' };
      if (args.some((a) => FORBIDDEN_CHARS.test(a))) return { ok: false, error: 'invalid command argument' };
      const [command, ...rest] = args;
      const result = await forward({ tool: 'bash', command, args: rest });
      return result.ok
        ? { ok: true, exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
        : { ok: false, error: result.error };
    },
  };
}
