/**
 * Harness-owned hardened Git helper for arbitrary task repositories.
 *
 * SYNC-BINDING: this file duplicates the exact hardened override set and
 * minimal environment of src/domains/verification/pool-proof-verifier.ts
 * (buildMinimalGitEnv and the hardened git() wrapper, lines 79-110). The two
 * copies MUST stay in sync: any hardening change there must be mirrored here.
 * src/domains edits are out of scope for this harness, which is why the
 * duplication exists instead of a shared export. Drift is controlled by the
 * AST call-site enumeration test (every git call in run-task.ts routes through
 * this helper) and the hostile-config mutation test bound to this module.
 */

import { spawnSync } from 'node:child_process';

export function hardenedGitEnv(): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    HOME: '/dev/null',
  };
}

export function hardenedGit(
  gitPath: string,
  workspacePath: string,
  args: readonly string[],
): { ok: true; stdout: string; stderr: string } | { ok: false; error: string } {
  try {
    // Neutralize repo-local execution-capable Git config. A hostile .git/config
    // can set core.fsmonitor, core.hooksPath, diff.external, etc. to run host
    // commands during otherwise read-only Git operations.
    const hardenedArgs = [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'diff.external=',
      '-c', 'core.pager=',
      '-c', 'core.editor=',
      '--no-optional-locks',
      ...args,
    ];
    const result = spawnSync(gitPath, hardenedArgs, {
      cwd: workspacePath,
      encoding: 'utf8',
      env: hardenedGitEnv(),
    });
    if (result.status === null || result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || `git exited ${String(result.status)}`).trim() };
    }
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
