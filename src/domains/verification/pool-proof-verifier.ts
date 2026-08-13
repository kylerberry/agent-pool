/**
 * Runner-owned deterministic verifier for Pool Proof Stage 1.
 *
 * The Worker does not declare its own success. This verifier independently
 * checks process binding, workspace containment, commit shape, parent, allowed
 * paths, clean repository state, fixture outcome, isolation, and absence of a
 * conflicting result before the runner records passed.
 *
 * All Git state is read through a trusted `git` subprocess using a minimal
 * environment, never by reading `.git` files directly.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AttemptResources } from '../agent-execution/attempt-resources.ts';
import type { PiProcess } from '../agent-execution/pool-proof-pi-launcher.ts';

export type VerifierCheck = {
  readonly name: string;
  readonly passed: boolean;
};

export type GreenEvidence = {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the runner discarded excess stream bytes during receipt. */
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
};

export type VerifierVerdict = {
  readonly status: 'passed' | 'failed';
  readonly commitSha: string | null;
  readonly failureCode: string | null;
  readonly checks: readonly VerifierCheck[];
  readonly greenEvidence: GreenEvidence | null;
};

export type ProofJobForVerifier = {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly allowedChangedPaths: readonly string[];
  readonly fixtureTestCommand: readonly string[];
  readonly expectedParentCommit?: string;
  readonly isolationProbes?: readonly string[];
};

export type FixtureTestRunner = (
  cwd: string,
  command: readonly string[],
) => Promise<GreenEvidence>;

export type ConflictQuery = (attemptId: string, resultId: string) => Promise<{
  readonly hasConflict: boolean;
  readonly existingResultId: string | null;
}>;

export type PoolProofVerifierOptions = {
  /** Absolute path to the trusted git executable. */
  readonly gitPath: string;
  /** Required sandbox fixture-test runner; no host fallback. */
  readonly fixtureTestRunner: FixtureTestRunner;
  /** Returns conflict status and any existing result id for the attempt. */
  readonly hasConflictingResult: ConflictQuery;
};

export type PoolProofVerifier = {
  readonly verify: (
    resources: AttemptResources,
    job: ProofJobForVerifier,
    process: PiProcess,
  ) => Promise<VerifierVerdict>;
};

function buildMinimalGitEnv(): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    HOME: '/dev/null',
  };
}

function git(gitPath: string, workspacePath: string, args: readonly string[]): { ok: true; stdout: string; stderr: string } | { ok: false; error: string } {
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
      env: buildMinimalGitEnv(),
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function checkWorkspaceContainment(workspacePath: string, gitPath: string): boolean {
  try {
    const real = realpathSync(workspacePath);
    if (!isAbsolute(real) || !lstatSync(real).isDirectory()) return false;
    const toplevel = git(gitPath, workspacePath, ['rev-parse', '--show-toplevel']);
    if (!toplevel.ok) return false;
    const realTop = realpathSync(toplevel.stdout);
    return realTop === real;
  } catch {
    return false;
  }
}

function readGitSha(gitPath: string, workspacePath: string): string | null {
  const result = git(gitPath, workspacePath, ['rev-parse', 'HEAD']);
  if (!result.ok) return null;
  const sha = result.stdout;
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function readGitParent(gitPath: string, workspacePath: string): string | null {
  const result = git(gitPath, workspacePath, ['rev-parse', 'HEAD^']);
  if (!result.ok) return null;
  const sha = result.stdout;
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function readGitStatus(gitPath: string, workspacePath: string): string[] {
  const result = git(gitPath, workspacePath, ['status', '--porcelain']);
  if (!result.ok) return ['error'];
  const lines = result.stdout ? result.stdout.split('\n').filter(Boolean) : [];
  if (lines.length > 0 && process.env.POOL_PROOF_DEBUG) {
    console.error(`[pool-proof-verifier] dirty tree (${lines.length}):\n${lines.join('\n')}`);
  }
  return lines;
}

function readCommitsSinceParent(gitPath: string, workspacePath: string, parentCommit: string): number | null {
  const result = git(gitPath, workspacePath, ['rev-list', '--count', `${parentCommit}..HEAD`]);
  if (!result.ok) return null;
  const n = Number(result.stdout);
  return Number.isInteger(n) ? n : null;
}

function readChangedPaths(gitPath: string, workspacePath: string): string[] {
  const result = git(gitPath, workspacePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function checkAllowedPaths(changed: readonly string[], allowed: readonly string[]): boolean {
  if (changed.length === 0) return false;
  for (const path of changed) {
    if (!allowed.some((a) => path === a || path.startsWith(`${a}/`))) return false;
  }
  return true;
}

type CollaboratorRun = {
  readonly passed: boolean;
  readonly evidence: GreenEvidence | null;
  readonly failureCode: 'FIXTURE_TEST_RUNNER_FAILED' | 'ISOLATION_RUNNER_FAILED' | null;
};

function failedCollaboratorEvidence(message: string): GreenEvidence {
  return { command: [], exitCode: 1, stdout: '', stderr: message, timedOut: false };
}

function isGreenEvidence(value: unknown): value is GreenEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Partial<GreenEvidence>;
  return Array.isArray(evidence.command)
    && evidence.command.every((part) => typeof part === 'string')
    && typeof evidence.exitCode === 'number'
    && Number.isFinite(evidence.exitCode)
    && typeof evidence.stdout === 'string'
    && typeof evidence.stderr === 'string'
    && typeof evidence.timedOut === 'boolean'
    && (evidence.stdoutTruncated === undefined || typeof evidence.stdoutTruncated === 'boolean')
    && (evidence.stderrTruncated === undefined || typeof evidence.stderrTruncated === 'boolean');
}

function isConflictResult(value: unknown): value is { readonly hasConflict: boolean; readonly existingResultId: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as { hasConflict?: unknown; existingResultId?: unknown };
  return typeof result.hasConflict === 'boolean'
    && (typeof result.existingResultId === 'string' || result.existingResultId === null);
}

async function runFixtureTest(
  runner: FixtureTestRunner,
  workspacePath: string,
  command: readonly string[],
): Promise<CollaboratorRun> {
  if (command.length === 0) {
    return {
      passed: false,
      evidence: { command, exitCode: 1, stdout: '', stderr: 'empty fixture test command', timedOut: false },
      failureCode: null,
    };
  }
  try {
    const evidence: unknown = await runner(workspacePath, command);
    if (!isGreenEvidence(evidence)) {
      return { passed: false, evidence: failedCollaboratorEvidence('fixture test runner failed'), failureCode: 'FIXTURE_TEST_RUNNER_FAILED' };
    }
    return { passed: evidence.exitCode === 0 && !evidence.timedOut, evidence, failureCode: null };
  } catch {
    return { passed: false, evidence: failedCollaboratorEvidence('fixture test runner failed'), failureCode: 'FIXTURE_TEST_RUNNER_FAILED' };
  }
}

async function runIsolationProbes(
  runner: FixtureTestRunner,
  workspacePath: string,
  probes: readonly string[],
): Promise<CollaboratorRun> {
  for (const probe of probes) {
    try {
      const evidence: unknown = await runner(workspacePath, ['sh', '-c', probe]);
      if (!isGreenEvidence(evidence)) {
        return { passed: false, evidence: failedCollaboratorEvidence('isolation runner failed'), failureCode: 'ISOLATION_RUNNER_FAILED' };
      }
      if (evidence.exitCode === 0) {
        return { passed: false, evidence, failureCode: null };
      }
    } catch {
      return { passed: false, evidence: failedCollaboratorEvidence('isolation runner failed'), failureCode: 'ISOLATION_RUNNER_FAILED' };
    }
  }
  return { passed: true, evidence: null, failureCode: null };
}

export function createPoolProofVerifier(options: PoolProofVerifierOptions): PoolProofVerifier {
  const gitPath = options.gitPath;
  const runner = options.fixtureTestRunner;
  const conflictQuery = options.hasConflictingResult;

  return {
    async verify(resources, job, process): Promise<VerifierVerdict> {
      const checks: VerifierCheck[] = [];

      const processExitedOk = process.exitCode === 0;
      checks.push({ name: 'process_exit_success', passed: processExitedOk });

      const nodeBound = process.nodeId === job.nodeId;
      checks.push({ name: 'process_node_binding', passed: nodeBound });

      const attemptBound = process.attemptId === job.attemptId;
      checks.push({ name: 'process_attempt_binding', passed: attemptBound });

      const nonceBound = process.attemptNonce === resources.nonce;
      checks.push({ name: 'process_nonce_binding', passed: nonceBound });

      const resultBound = process.resultId === resources.resultId;
      checks.push({ name: 'process_result_binding', passed: resultBound });

      const workspaceContained = checkWorkspaceContainment(resources.workspacePath, gitPath);
      checks.push({ name: 'workspace_contained', passed: workspaceContained });

      const gitDir = resolve(resources.workspacePath, '.git');
      const gitExists = existsSync(gitDir) && lstatSync(gitDir).isDirectory();
      checks.push({ name: 'git_directory_present', passed: gitExists });

      let commitSha: string | null = null;
      let parentOk = false;
      let cleanTree = false;
      let allowedPaths = false;
      let oneCommit = false;

      if (gitExists) {
        commitSha = readGitSha(gitPath, resources.workspacePath);
        checks.push({ name: 'commit_resolved', passed: commitSha !== null });

        const parent = readGitParent(gitPath, resources.workspacePath);
        parentOk = job.expectedParentCommit ? parent === job.expectedParentCommit : parent !== null;
        checks.push({ name: 'expected_parent', passed: parentOk });

        if (job.expectedParentCommit) {
          const commitsSinceParent = readCommitsSinceParent(gitPath, resources.workspacePath, job.expectedParentCommit);
          oneCommit = commitsSinceParent === 1;
        } else {
          oneCommit = parent !== null;
        }
        checks.push({ name: 'exactly_one_commit', passed: oneCommit });

        const changed = readChangedPaths(gitPath, resources.workspacePath);
        allowedPaths = checkAllowedPaths(changed, job.allowedChangedPaths);
        checks.push({ name: 'allowed_paths_only', passed: allowedPaths });

        cleanTree = readGitStatus(gitPath, resources.workspacePath).length === 0;
        checks.push({ name: 'clean_tree', passed: cleanTree });
      }

      const fixtureResult = await runFixtureTest(runner, resources.workspacePath, job.fixtureTestCommand);
      checks.push({ name: 'fixture_test_passes', passed: fixtureResult.passed });

      const DEFAULT_ISOLATION_PROBES = [
        '[ -n "$OPENAI_API_KEY" ] || [ -n "$MOONSHOT_API_KEY" ]',
        '[ -e /var/run/docker.sock ]',
        '[ -r /root/.pi/agent/auth.json ] || [ -r /root/.ssh/id_rsa ] || [ -r /etc/shadow ] || [ "$(id -u)" = "0" ]',
      ];
      const isolationProbes = job.isolationProbes ?? DEFAULT_ISOLATION_PROBES;
      const isolationResult = await runIsolationProbes(runner, resources.workspacePath, isolationProbes);
      checks.push({ name: 'isolation_probes_pass', passed: isolationResult.passed });

      let conflict: { hasConflict: boolean; failureCode: 'CONFLICT_QUERY_FAILED' | null };
      try {
        const value: unknown = await conflictQuery(job.attemptId, resources.resultId);
        conflict = isConflictResult(value)
          ? { hasConflict: value.hasConflict, failureCode: null }
          : { hasConflict: true, failureCode: 'CONFLICT_QUERY_FAILED' };
      } catch {
        conflict = { hasConflict: true, failureCode: 'CONFLICT_QUERY_FAILED' };
      }
      const noConflictingResult = !conflict.hasConflict;
      checks.push({ name: 'no_conflicting_result', passed: noConflictingResult });

      const allPassed = checks.every((c) => c.passed);
      const collaboratorFailure = fixtureResult.failureCode ?? isolationResult.failureCode ?? conflict.failureCode;
      return {
        status: allPassed ? 'passed' : 'failed',
        // A resolved HEAD is evidence only until every verifier check passes.
        // In particular, a failed launch can still point at the fixture base.
        commitSha: allPassed ? commitSha : null,
        failureCode: allPassed ? null : (process.failureCode ?? collaboratorFailure ?? 'VERIFIER_CHECK_FAILED'),
        checks,
        greenEvidence: allPassed ? fixtureResult.evidence : null,
      };
    },
  };
}
