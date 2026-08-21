/**
 * Integrated task runner tests.
 *
 * Drives the exported runTask() through the real Minimal Pool Runtime
 * composition, real verifier, and real git clone/checkout path, with fake
 * launcher and sandbox-command provenance only (run-stage-2 pattern). Covers
 * the fake-adapter green path including multi-command verification, hostile
 * Worker mutations (out-of-allowed-paths commit, two commits, dirty tree),
 * zero-side-effect manifest rejection, the retained-reports containment guard
 * (before any mkdir, asserted with a full recursive reports/ tree snapshot
 * before and after every test), AST enumeration that every git call in
 * run-task.ts routes through hardened-git.ts, the hostile .git config
 * mutation case bound to the hardened-git helper, and the manifest-bound
 * sandbox timeout (60/900) captured through the fake seam.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  runTask,
  createConfiguredRepositoryBoundPool,
  resolveCandidateOutputPath,
  prepareTaskWorkspace,
  parseContainerRuntime,
  resolveContainerRuntime,
  type RunTaskOptions,
} from '../src/run-task.ts';
import { hardenedGit, hardenedGitEnv } from '../src/hardened-git.ts';
import { validateTaskRunEvidence, type TaskRunEvidence } from '../src/task-run-evidence.ts';
import type { PreflightSuccess } from '../src/preflight.ts';
import { createRepositoryBoundPool, createRepositoryBoundTaskContent, type PiLauncher, type PiProcess, type PoolProofLaunchExpectations, type ProofJob } from '../../../src/domains/agent-execution/index.ts';
import type { GreenEvidence } from '../../../src/domains/verification/pool-proof-verifier.ts';
import { createTempRoot } from './helpers/temp-root.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = join(packageRoot, 'reports');

/** Full recursive snapshot of the retained reports tree (path -> digest). */
function snapshotReportsTree(): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) {
        snapshot.set(rel, 'dir');
        walk(full, rel);
      } else {
        snapshot.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    }
  };
  walk(reportsDir, '');
  return snapshot;
}

let reportsBaseline: Map<string, string>;
beforeEach(() => {
  reportsBaseline = snapshotReportsTree();
});
afterEach(() => {
  assert.deepEqual([...snapshotReportsTree().entries()].sort(), [...reportsBaseline.entries()].sort(),
    'retained reports/ tree must be byte-identical with zero new entries');
});

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'Worker',
  GIT_AUTHOR_EMAIL: 'worker@agent-pool.local',
  GIT_COMMITTER_NAME: 'Worker',
  GIT_COMMITTER_EMAIL: 'worker@agent-pool.local',
};

function git(cwd: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function gitPath(): string {
  return spawnSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).stdout.trim() || 'git';
}

type TaskRepo = {
  readonly repoPath: string;
  readonly baseCommit: string;
  readonly headFile: string;
};

/** Test-owned temp git repository; sandbox scaffolding (.home/) is ignored at base. */
function makeTaskRepo(t: { after: (fn: () => void) => void }, root: string): TaskRepo {
  const repoPath = join(root, 'task-repo');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, '.gitignore'), '.home/\n');
  writeFileSync(join(repoPath, 'src', 'message.js'), 'export function getMessage() {\n  return \'hello\';\n}\n');
  mkdirSync(join(repoPath, 'test'), { recursive: true });
  writeFileSync(join(repoPath, 'test', 'message.test.js'), 'import assert from "node:assert/strict";\nimport { getMessage } from "../src/message.js";\nassert.equal(getMessage(), "hello");\n');
  assert.equal(git(repoPath, ['init', '-q']).status, 0);
  assert.equal(git(repoPath, ['add', '.']).status, 0);
  assert.equal(git(repoPath, ['commit', '-qm', 'task base']).status, 0, 'base commit failed');
  const baseCommit = String(git(repoPath, ['rev-parse', 'HEAD']).stdout).trim();
  assert.match(baseCommit, /^[0-9a-f]{40}$/);
  return { repoPath, baseCommit, headFile: 'src/message.js' };
}

function writeManifestFile(dir: string, manifest: Record<string, unknown>): string {
  const path = join(dir, 'task-manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function validManifest(repo: TaskRepo): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'demo-task',
    target_repo_path: repo.repoPath,
    base_commit: repo.baseCommit,
    intent: 'Make one approved change to the demo task repository.',
    change_spec: 'Update src/message.js so the verification command passes.',
    acceptance_criteria: [
      { id: 'c1', text: 'Only allowed paths change.' },
      { id: 'c2', text: 'All verification commands pass after the change.' },
    ],
    allowed_changed_paths: ['src/message.js'],
    verification_commands: [
      ['node', '--test', 'test/message.test.js'],
      ['sh', '-c', 'node --test test/message.test.js'],
      ['node', '--check', 'src/message.js'],
    ],
    model: 'moonshot/kimi-k2.7-code',
    bounds: { verification_timeout_seconds: 60 },
  };
}

function fakePreflight(): PreflightSuccess {
  return {
    pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
    package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
    profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
    sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
    gitPath: gitPath(),
  };
}

type SandboxCall = { readonly workspacePath: string; readonly command: readonly string[]; readonly timeoutSeconds: number };

type WorkerBehavior = (workspacePath: string) => void;

/** Commit the allowed file once — the canonical green Worker. */
function greenWorker(workspacePath: string): void {
  writeFileSync(join(workspacePath, 'src', 'message.js'), 'export function getMessage() {\n  return \'world\';\n}\n');
  assert.equal(git(workspacePath, ['add', 'src/message.js']).status, 0);
  assert.equal(git(workspacePath, ['commit', '-qm', 'task change']).status, 0, 'worker commit failed');
}

function makeFakeLauncher(behavior: WorkerBehavior): (expectations: PoolProofLaunchExpectations, job: ProofJob) => PiLauncher {
  return (expectations: PoolProofLaunchExpectations, job: ProofJob): PiLauncher => ({
    launch: async (marker: unknown): Promise<PiProcess> => {
      behavior(expectations.workspacePath);
      const nonce = typeof marker === 'object' && marker !== null && 'attempt_nonce' in marker
        ? String((marker as Record<string, unknown>).attempt_nonce)
        : 'nonce';
      return {
        pid: 4242,
        exitCode: 0,
        signalCode: null,
        timedOut: false,
        output: 'FAKE_WORKER_OUTPUT_MUST_NOT_BE_RETAINED',
        nodeId: job.nodeId,
        attemptId: job.attemptId,
        attemptNonce: nonce,
        resultId: expectations.resultDestinationId,
        failureCode: null,
      };
    },
  });
}

type RunHarness = {
  readonly options: (manifestPath: string, extra?: Partial<RunTaskOptions>) => RunTaskOptions;
  readonly sandboxCalls: SandboxCall[];
};

/** Build runTask options with fake provenance, fake launcher, and a recording sandbox seam. */
function makeHarness(behavior: WorkerBehavior, manifest: Record<string, unknown>): RunHarness {
  const sandboxCalls: SandboxCall[] = [];
  const allowedCommands = ((manifest as Record<string, unknown>).verification_commands as string[][]).map((c) => JSON.stringify(c));
  return {
    sandboxCalls,
    options: (manifestPath: string, extra: Partial<RunTaskOptions> = {}): RunTaskOptions => ({
      manifestPath,
      preflight: fakePreflight(),
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
      adapterOverrides: {
        createPiLauncher: makeFakeLauncher(behavior),
        runSandboxCommand: async (workspacePath, command, timeoutSeconds): Promise<GreenEvidence> => ({
          command,
          exitCode: allowedCommands.includes(JSON.stringify(command)) ? 0 : 1,
          stdout: '',
          stderr: '',
          timedOut: false,
          ...(sandboxCalls.push({ workspacePath, command, timeoutSeconds }) ? {} : {}),
        }),
      },
      ...extra,
    }),
  };
}

describe('runTask task runner', () => {
  it('uses a no-hardlinks clone before checking out configured workspaces', () => {
    const source = readFileSync(join(packageRoot, 'src', 'run-task.ts'), 'utf8');
    assert.match(source, /\['clone', '--no-hardlinks', '--no-checkout', sourceRepoPath, workspacePath\]/);
  });

  it('runs frozen configured policy from a real local branch without accepting a manifest path', async (t) => {
    const tmpRoot = createTempRoot(t, 'configured-run-task-');
    const repo = makeTaskRepo(t, tmpRoot);
    const poolHome = join(tmpRoot, 'pool-home');
    const runtimeRoot = join(poolHome, 'runtime');
    const persistentReviewCheckout = join(tmpRoot, 'review');
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    git(tmpRoot, ['clone', '-q', repo.repoPath, persistentReviewCheckout]);
    chmodSync(poolHome, 0o700); chmodSync(runtimeRoot, 0o700); chmodSync(repo.repoPath, 0o700); chmodSync(persistentReviewCheckout, 0o700);
    const branch = String(git(repo.repoPath, ['symbolic-ref', '--short', 'HEAD']).stdout).trim();
    const pool = createRepositoryBoundPool({
      poolHome, runtimeRoot, repositoryRoot: repo.repoPath, persistentReviewCheckout, baseRef: `refs/heads/${branch}`,
      allowedChangedPaths: ['src/message.js'],
      verificationCommands: [['node', '--test', 'test/message.test.js']],
      model: 'moonshot/kimi-k2.7-code', bounds: { verificationTimeoutSeconds: 60, launchTimeoutSeconds: 60 },
    }, (root) => String(git(root, ['rev-parse', '--show-toplevel']).stdout).trim());
    const task = createRepositoryBoundTaskContent({
      taskId: 'configured-task', intent: 'change the message', changeSpec: 'make the test pass',
      acceptanceCriteria: [{ id: 'c1', text: 'only the allowed file changes' }],
    });
    const manifest = validManifest(repo);
    const harness = makeHarness(greenWorker, manifest);
    const configured = createConfiguredRepositoryBoundPool(pool, {
      preflight: fakePreflight(), containerRuntime: 'docker', sandboxImage: 'sha256:fake',
      adapterOverrides: harness.options('ignored').adapterOverrides,
    });
    const result = await configured.run(task);
    assert.equal(result.ok, true, result.ok ? '' : `${result.failureCode}: ${result.reason}`);
    assert.equal(existsSync(runtimeRoot), true);
    assert.deepEqual(readdirSync(runtimeRoot), [], 'configured execution root must be cleaned');
    assert.ok(harness.sandboxCalls.every((call) => call.timeoutSeconds === 60));
  });

  it('runs a fake-adapter green path with multi-command verification and writes schema-valid evidence', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-green-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifest = validManifest(repo);
    const manifestPath = writeManifestFile(tmpRoot, manifest);
    const reportOutputPath = join(tmpRoot, 'candidate', 'task-run-evidence.json');
    const harness = makeHarness(greenWorker, manifest);

    const result = await runTask(harness.options(manifestPath, { reportOutputPath }));
    assert.equal(result.ok, true, result.ok ? '' : `${result.failureCode}: ${result.reason}`);
    if (!result.ok) return;

    assert.equal(result.report.status, 'passed');
    const realTmpRoot = realpathSync(tmpRoot);
    assert.ok(result.evidencePath.startsWith(realTmpRoot), 'evidence must land at the test-owned candidate path');
    assert.equal(existsSync(result.evidencePath), true);

    // Evidence is schema-valid on disk and binds the manifest identity.
    const written: TaskRunEvidence = JSON.parse(readFileSync(result.evidencePath, 'utf8'));
    assert.deepEqual(validateTaskRunEvidence(written), { ok: true });
    assert.equal(written.manifest_sha256, createHash('sha256').update(readFileSync(manifestPath)).digest('hex'));
    assert.equal(written.task_id, 'demo-task');
    assert.equal(written.base_commit, repo.baseCommit);
    assert.equal(written.selected_model, 'moonshot/kimi-k2.7-code');
    assert.ok(written.attempt_id.length > 0);
    assert.ok(written.result_id.length > 0);
    assert.match(written.result_commit ?? '', /^[0-9a-f]{40}$/);
    assert.notEqual(written.result_commit, repo.baseCommit);
    assert.equal(written.process.exit_code, 0);
    assert.equal(written.process.pid_present, true);
    assert.equal(written.cleanup_disposition.workspace_removed, true);
    assert.equal(written.cleanup_disposition.session_removed, true);
    assert.ok(!JSON.stringify(written).includes('FAKE_WORKER_OUTPUT_MUST_NOT_BE_RETAINED'));

    // The verifier consumed the first command; the runner evaluated the rest.
    const checks = new Map(written.verifier_checks.map((c) => [c.name, c.passed]));
    assert.equal(checks.get('fixture_test_passes'), true, 'verifier consumed the first verification command');
    assert.equal(checks.get('verification_command_2'), true, 'runner evaluated the second command');
    assert.equal(checks.get('verification_command_3'), true, 'runner evaluated the third command');
    assert.ok([...checks.values()].every(Boolean), 'all merged checks pass');

    // Base-state evidence is informational: first command ran at base.
    assert.equal(written.base_state_evidence.length, 1);
    assert.deepEqual(written.base_state_evidence[0]!.command, ((manifest as Record<string, unknown>).verification_commands as string[][])[0]);

    // The workspace clone is gone after cleanup.
    assert.equal(existsSync(join(tmpRoot, 'task-repo')), true, 'source repo untouched');
  });

  it('rejects a Worker commit outside allowed paths with allowed_paths_only=false', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-outside-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifest = validManifest(repo);
    const manifestPath = writeManifestFile(tmpRoot, manifest);
    const hostile: WorkerBehavior = (workspacePath) => {
      writeFileSync(join(workspacePath, 'src', 'message.js'), 'export const changed = true;\n');
      // A root-level file is outside the allowed paths (src/message.js only).
      writeFileSync(join(workspacePath, 'sneaky.md'), 'not allowed\n');
      assert.equal(git(workspacePath, ['add', '.']).status, 0);
      assert.equal(git(workspacePath, ['commit', '-qm', 'mixed change']).status, 0);
    };
    const harness = makeHarness(hostile, manifest);
    const result = await runTask(harness.options(manifestPath, { reportOutputPath: join(tmpRoot, 'candidate', 'task-run-evidence.json') }));
    assert.equal(result.ok, true, 'pipeline completes; the verifier records the failure');
    if (!result.ok) return;
    assert.equal(result.report.status, 'failed');
    assert.ok(result.report.diagnostics.failure_code);
    const checks = new Map(result.report.verifier_checks.map((c) => [c.name, c.passed]));
    assert.equal(checks.get('allowed_paths_only'), false, 'out-of-allowed-paths commit detected');
    assert.equal(checks.get('exactly_one_commit'), true);
    assert.equal(checks.get('clean_tree'), true);
  });

  it('rejects two Worker commits with exactly_one_commit=false', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-twocommits-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifest = validManifest(repo);
    const manifestPath = writeManifestFile(tmpRoot, manifest);
    const hostile: WorkerBehavior = (workspacePath) => {
      writeFileSync(join(workspacePath, 'src', 'message.js'), 'export const a = 1;\n');
      assert.equal(git(workspacePath, ['add', '.']).status, 0);
      assert.equal(git(workspacePath, ['commit', '-qm', 'first']).status, 0);
      writeFileSync(join(workspacePath, 'src', 'message.js'), 'export const b = 2;\n');
      assert.equal(git(workspacePath, ['add', '.']).status, 0);
      assert.equal(git(workspacePath, ['commit', '-qm', 'second']).status, 0);
    };
    const harness = makeHarness(hostile, manifest);
    const result = await runTask(harness.options(manifestPath, { reportOutputPath: join(tmpRoot, 'candidate', 'task-run-evidence.json') }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.report.status, 'failed');
    const checks = new Map(result.report.verifier_checks.map((c) => [c.name, c.passed]));
    assert.equal(checks.get('exactly_one_commit'), false, 'two commits detected');
    assert.equal(checks.get('expected_parent'), false);
  });

  it('rejects a dirty tree with clean_tree=false', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-dirty-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifest = validManifest(repo);
    const manifestPath = writeManifestFile(tmpRoot, manifest);
    const hostile: WorkerBehavior = (workspacePath) => {
      greenWorker(workspacePath);
      writeFileSync(join(workspacePath, 'src', 'untracked.txt'), 'dirt\n');
    };
    const harness = makeHarness(hostile, manifest);
    const result = await runTask(harness.options(manifestPath, { reportOutputPath: join(tmpRoot, 'candidate', 'task-run-evidence.json') }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.report.status, 'failed');
    const checks = new Map(result.report.verifier_checks.map((c) => [c.name, c.passed]));
    assert.equal(checks.get('clean_tree'), false, 'dirty tree detected');
    assert.equal(checks.get('allowed_paths_only'), true);
    assert.equal(checks.get('exactly_one_commit'), true);
  });

  it('rejects an invalid manifest with zero store/resource/adapter/sandbox effects', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-nosideeffects-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifest = { ...validManifest(repo), base_commit: 'main' };
    const manifestPath = writeManifestFile(tmpRoot, manifest);
    const effects: string[] = [];
    const harness = makeHarness(greenWorker, validManifest(repo));
    const result = await runTask(harness.options(manifestPath, {
      reportOutputPath: join(tmpRoot, 'candidate', 'task-run-evidence.json'),
      sideEffectObserver: (effect) => effects.push(effect),
    }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'BASE_COMMIT_NOT_40HEX_SHA1');
    assert.deepEqual(effects, [], 'no side effect may precede manifest validation');
    assert.equal(result.evidencePath, null);
    assert.equal(result.report, null);
    assert.equal(existsSync(join(tmpRoot, 'candidate')), false, 'no candidate directory may be created');
  });

  it('rejects output resolving inside the retained reports/ tree before any mkdir, including new subdirectories', (t) => {
    const hostile = [
      join(reportsDir, 'task-run-evidence.json'),
      join(reportsDir, 'new-subdir', 'task-run-evidence.json'),
      join(reportsDir, 'deeper', 'still-new', 'task-run-evidence.json'),
    ];
    for (const path of hostile) {
      assert.throws(() => resolveCandidateOutputPath(path), /TASK_OUTPUT_INSIDE_RETAINED_REPORTS/, `must reject ${path}`);
    }
    // No new directory may exist after the rejections (the tree snapshot after
    // this test asserts byte-identical retained state globally).
    assert.equal(existsSync(join(reportsDir, 'new-subdir')), false);
    assert.equal(existsSync(join(reportsDir, 'deeper', 'still-new')), false);

    // A normal external candidate path is allowed and its directory created.
    const tmpRoot = createTempRoot(t, 'run-task-guard-ok-');
    const allowed = resolveCandidateOutputPath(join(tmpRoot, 'candidate', 'nested', 'task-run-evidence.json'));
    assert.equal(basename(allowed), 'task-run-evidence.json');
    assert.ok(allowed.startsWith(realpathSync(tmpRoot)));
    assert.equal(existsSync(dirname(allowed)), true);
  });

  it('runTask rejects a reportOutputPath inside reports/ with the bounded code and no evidence write', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-guard-run-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifestPath = writeManifestFile(tmpRoot, validManifest(repo));
    const harness = makeHarness(greenWorker, validManifest(repo));
    const effects: string[] = [];
    const result = await runTask(harness.options(manifestPath, {
      reportOutputPath: join(reportsDir, 'run-task-hostile', 'task-run-evidence.json'),
      sideEffectObserver: (effect) => effects.push(effect),
    }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'TASK_OUTPUT_INSIDE_RETAINED_REPORTS');
    assert.equal(result.evidencePath, null);
    assert.equal(existsSync(join(reportsDir, 'run-task-hostile')), false);
    assert.deepEqual(effects, [], 'the guard fires before any runner side effect');
  });

  it('enumerates every git call site in run-task.ts through hardened-git (AST/token analysis)', () => {
    const source = readFileSync(join(packageRoot, 'src', 'run-task.ts'), 'utf8');

    // Lexical tokenization with comments removed and string/template contents
    // preserved as string tokens (never raw source substrings).
    type Token = { kind: 'ident' | 'string' | 'other'; value: string };
    const tokens: Token[] = [];
    let i = 0;
    while (i < source.length) {
      const c = source[i]!;
      if (/\s/.test(c)) { i += 1; continue; }
      if (c === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const quote = c;
        i += 1;
        let value = '';
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') { value += source[i + 1] ?? ''; i += 2; continue; }
          value += source[i]!;
          i += 1;
        }
        i += 1;
        tokens.push({ kind: 'string', value });
        continue;
      }
      if (c === '`') {
        i += 1;
        let depth = 0;
        let value = '';
        while (i < source.length) {
          const ch = source[i]!;
          if (ch === '\\') { i += 2; continue; }
          if (ch === '$' && source[i + 1] === '{') { depth += 1; i += 2; value += '${'; continue; }
          if (ch === '}' && depth > 0) { depth -= 1; i += 1; value += '}'; continue; }
          if (ch === '`' && depth === 0) { i += 1; break; }
          value += ch;
          i += 1;
        }
        tokens.push({ kind: 'string', value });
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let value = '';
        while (i < source.length && /[A-Za-z0-9_$]/.test(source[i]!)) { value += source[i]!; i += 1; }
        tokens.push({ kind: 'ident', value });
        continue;
      }
      tokens.push({ kind: 'other', value: c });
      i += 1;
    }

    // hardenedGit must be statically imported from the harness hardened-git module.
    const imports: string[] = [];
    for (let k = 0; k < tokens.length; k += 1) {
      const tok = tokens[k]!;
      if (tok.kind !== 'ident' || tok.value !== 'import') continue;
      if (tokens[k + 1]?.kind === 'other' && tokens[k + 1]!.value === '{') {
        let end = k + 2;
        const names: string[] = [];
        while (end < tokens.length && tokens[end]!.kind === 'ident' && tokens[end]!.value !== 'from') {
          names.push(tokens[end]!.value);
          end += 2; // skip the separating comma
        }
        // The import specifier is the next string token after 'from'.
        while (end < tokens.length && tokens[end]!.kind !== 'string') end += 1;
        if (tokens[end]) imports.push(`${names.join(',')} from ${tokens[end]!.value}`);
      }
    }
    assert.ok(
      imports.some((decl) => decl.includes('./hardened-git.ts') && decl.split(' from ')[0]!.split(',').includes('hardenedGit')),
      `run-task.ts must import hardenedGit from './hardened-git.ts'; saw: ${imports.join(' | ')}`,
    );

    // Enumerate call sites: identifier (optionally member-qualified) followed by '('.
    const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'do', 'else', 'in', 'of', 'await', 'yield', 'throw']);
    const SPAWN_PRIMS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']);
    const directGitSites: string[] = [];
    let gitCallsFound = 0;
    for (let k = 0; k < tokens.length; k += 1) {
      const tok = tokens[k]!;
      if (tok.kind !== 'ident' || KEYWORDS.has(tok.value)) continue;
      if (tokens[k + 1]?.kind !== 'other' || tokens[k + 1]!.value !== '(') continue;
      const prev = tokens[k - 1];
      const isMember = prev?.kind === 'other' && (prev.value === '.' || prev.value === '?.');
      const name = tok.value;

      if (name === 'hardenedGit') {
        assert.equal(isMember, false, 'hardenedGit must be called as the imported helper, not a member');
        gitCallsFound += 1;
      } else if (/git/i.test(name) && !isMember) {
        // Any bare identifier call with a git-ish name that is not hardenedGit.
        directGitSites.push(name);
      }
      if (SPAWN_PRIMS.has(name)) {
        const arg = tokens[k + 2];
        assert.ok(
          !(arg?.kind === 'string' && (arg.value === 'git' || arg.value.endsWith('/git'))),
          `direct git spawn detected at ${name}('${arg?.value}')`,
        );
      }
    }
    assert.ok(gitCallsFound > 0, 'run-task.ts must route git through hardenedGit');
    assert.deepEqual(directGitSites, [], `every git call must go through hardened-git.ts; direct sites: ${directGitSites.join(', ')}`);
  });

  it('hardened-git neutralizes hostile .git config during clone, checkout, and verification reads', (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-hostile-config-');
    const markersDir = join(tmpRoot, 'markers');
    mkdirSync(markersDir);
    const repoPath = join(tmpRoot, 'hostile-repo');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, '.gitignore'), '.home/\n');
    writeFileSync(join(repoPath, 'src', 'message.js'), 'export const x = 1;\n');
    assert.equal(git(repoPath, ['init', '-q']).status, 0);
    assert.equal(git(repoPath, ['add', '.']).status, 0);
    assert.equal(git(repoPath, ['commit', '-qm', 'root']).status, 0);
    writeFileSync(join(repoPath, 'src', 'message.js'), 'export const x = 0;\n');
    assert.equal(git(repoPath, ['add', '.']).status, 0);
    assert.equal(git(repoPath, ['commit', '-qm', 'base']).status, 0);
    writeFileSync(join(repoPath, 'src', 'message.js'), 'export const x = 2;\n');
    assert.equal(git(repoPath, ['add', '.']).status, 0);
    assert.equal(git(repoPath, ['commit', '-qm', 'change']).status, 0);
    // Pin the middle commit so HEAD^ exists at the detached base.
    const baseCommit = String(git(repoPath, ['rev-parse', 'HEAD~1']).stdout).trim();

    // Hostile .git/config values: every one writes a marker if it ever executes
    // on the host during an otherwise read-only Git operation.
    const markerScript = (name: string): string => {
      const path = join(tmpRoot, `${name}.sh`);
      writeFileSync(path, `#!/bin/sh\ntouch ${JSON.stringify(join(markersDir, name))}\nexit 0\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const hooksDir = join(tmpRoot, 'hooks');
    mkdirSync(hooksDir);
    writeFileSync(join(hooksDir, 'post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(join(markersDir, 'postcheckout'))}\nexit 0\n`);
    chmodSync(join(hooksDir, 'post-checkout'), 0o755);
    const hostileConfig = [
      ['core.fsmonitor', markerScript('fsmonitor')],
      ['core.hooksPath', hooksDir],
      ['diff.external', markerScript('extdiff')],
    ] as const;
    for (const [key, value] of hostileConfig) {
      assert.equal(git(repoPath, ['config', key, value]).status, 0, `set hostile ${key}`);
    }

    const gp = gitPath();
    // Runner sequence: fresh clone + detached checkout + base assertions,
    // every git invocation through the harness hardened-git helper.
    const workspacePath = join(tmpRoot, 'task-workspace');
    prepareTaskWorkspace(gp, repoPath, workspacePath, baseCommit);

    // The worker-facing workspace config is attacker-reachable in production
    // (the sandbox mounts the workspace rw). Poison the clone identically and
    // re-run the checkout plus the verifier read sequence through hardenedGit.
    for (const [key, value] of hostileConfig) {
      assert.equal(git(workspacePath, ['config', key, value]).status, 0, `poison clone ${key}`);
    }
    const checkout = hardenedGit(gp, workspacePath, ['checkout', '-q', '--detach', baseCommit]);
    assert.ok(checkout.ok, 'hardened checkout must succeed');
    const head = hardenedGit(gp, workspacePath, ['rev-parse', 'HEAD']);
    assert.ok(head.ok && head.stdout === baseCommit);
    const parent = hardenedGit(gp, workspacePath, ['rev-parse', 'HEAD^']);
    assert.ok(parent.ok);
    const count = hardenedGit(gp, workspacePath, ['rev-list', '--count', `${baseCommit}..HEAD`]);
    assert.ok(count.ok && count.stdout === '0');
    const status = hardenedGit(gp, workspacePath, ['status', '--porcelain']);
    assert.ok(status.ok && status.stdout === '', 'hardened status must see a clean tree');
    const changed = hardenedGit(gp, workspacePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
    assert.ok(changed.ok);
    // diff.external binds through a patch-producing diff; under hardening the
    // empty override makes the command fail without executing anything.
    const diff = hardenedGit(gp, workspacePath, ['diff', 'HEAD^', 'HEAD']);
    void diff; // exit status is irrelevant; execution is what must not happen

    assert.deepEqual(readdirSync(markersDir).sort(), [], 'no hostile-config command may execute on the host');

    // The minimal hardened environment is exactly the duplicated override set.
    assert.deepEqual(hardenedGitEnv(), {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      HOME: '/dev/null',
    });
  });

  it('binds the sandbox-command timeout to manifest bounds (60 and 900, never a hardcoded 120)', async (t) => {
    for (const timeoutSeconds of [60, 900]) {
      const tmpRoot = createTempRoot(t, `run-task-timeout-${timeoutSeconds}-`);
      const repo = makeTaskRepo(t, tmpRoot);
      const manifest = {
        ...validManifest(repo),
        verification_commands: [['node', '--test', 'test/message.test.js']],
        bounds: { verification_timeout_seconds: timeoutSeconds },
      };
      const manifestPath = writeManifestFile(tmpRoot, manifest);
      const harness = makeHarness(greenWorker, manifest);
      const result = await runTask(harness.options(manifestPath, { reportOutputPath: join(tmpRoot, 'candidate', 'task-run-evidence.json') }));
      assert.equal(result.ok, true, result.ok ? '' : `${result.failureCode}: ${result.reason}`);
      assert.ok(harness.sandboxCalls.length >= 2, 'base-state + verifier command must both flow through the seam');
      for (const call of harness.sandboxCalls) {
        assert.equal(call.timeoutSeconds, timeoutSeconds, 'every sandbox call must use the manifest timeout');
      }
      assert.ok(!harness.sandboxCalls.some((c) => c.timeoutSeconds === 120), 'no hardcoded 120s path');
    }
  });

  it('rejects adapter overrides with all-real provenance at the entry point', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-real-override-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifestPath = writeManifestFile(tmpRoot, validManifest(repo));
    const harness = makeHarness(greenWorker, validManifest(repo));
    const options = harness.options(manifestPath);
    const result = await runTask({
      ...options,
      adapterProvenance: { launcher: 'real', sandbox: 'real', verifier: 'real', persistence: 'real' },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'POOL_PROOF_REAL_ADAPTER_OVERRIDE_REJECTED');
  });

  it('rejects fake provenance without adapter overrides at the entry point', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-fake-nooverride-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifestPath = writeManifestFile(tmpRoot, validManifest(repo));
    const result = await runTask({
      manifestPath,
      preflight: fakePreflight(),
      containerRuntime: 'docker',
      sandboxImage: 'sha256:fake',
      adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'fake', persistence: 'fake' },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'POOL_PROOF_FAKE_ADAPTER_REJECTED');
  });

  it('rejects a --model cross-check mismatch before any side effect', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-modelmismatch-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifestPath = writeManifestFile(tmpRoot, validManifest(repo));
    const harness = makeHarness(greenWorker, validManifest(repo));
    const effects: string[] = [];
    const result = await runTask(harness.options(manifestPath, {
      modelOverride: 'openai-codex/gpt-5.6-terra',
      sideEffectObserver: (effect) => effects.push(effect),
    }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failureCode, 'TASK_MODEL_MISMATCH');
    assert.deepEqual(effects, []);
  });

  it('cleans up the task workspace and runtime root on completion', async (t) => {
    const tmpRoot = createTempRoot(t, 'run-task-cleanup-');
    const repo = makeTaskRepo(t, tmpRoot);
    const manifestPath = writeManifestFile(tmpRoot, validManifest(repo));
    const harness = makeHarness(greenWorker, validManifest(repo));
    // Only runner-owned temp prefixes are enumerated (never the shared root).
    const owned = (): string[] => readdirSync(tmpdir()).filter((name) => /^pool-proof-task-/.test(name)).sort();
    const before = owned();
    const result = await runTask(harness.options(manifestPath, { reportOutputPath: join(tmpRoot, 'candidate', 'task-run-evidence.json') }));
    assert.equal(result.ok, true);
    assert.deepEqual(owned(), before, 'no pool-proof-task temp roots may survive the run');
  });

  it('rejects an invalid --container-runtime value before any container launch', () => {
    assert.throws(
      () => parseContainerRuntime('docker; touch /tmp/pwned'),
      /CONTAINER_RUNTIME_INVALID/,
      'must reject a shell-injection payload in --container-runtime',
    );
    assert.throws(
      () => parseContainerRuntime('podman '),
      /CONTAINER_RUNTIME_INVALID/,
      'must reject values that are not literally docker or podman',
    );
    assert.equal(parseContainerRuntime('docker'), 'docker');
    assert.equal(parseContainerRuntime('podman'), 'podman');
  });

  it('resolveContainerRuntime rejects a symlink and a non-regular file', (t) => {
    const tmpRoot = createTempRoot(t, 'resolve-runtime-');
    const binDir = join(tmpRoot, 'bin');
    mkdirSync(binDir);

    // A real regular file to serve as a symlink target.
    const realDocker = join(binDir, 'docker-real');
    writeFileSync(realDocker, '#!/bin/sh\necho docker\n');
    chmodSync(realDocker, 0o755);

    // A symlink named docker -> regular file must be rejected before launch.
    const symlinkDocker = join(binDir, 'docker');
    symlinkSync(realDocker, symlinkDocker);

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${originalPath}`;
      assert.throws(
        () => resolveContainerRuntime('docker'),
        /CONTAINER_RUNTIME_IS_SYMLINK/,
        'must reject a symlinked container runtime',
      );
    } finally {
      process.env.PATH = originalPath;
    }

    // Use a fake `command` shim that returns a directory path, so the
    // post-realpath lstat hits the non-regular-file check.
    rmSync(symlinkDocker);
    const fakeDockerDir = join(tmpRoot, 'docker-dir');
    mkdirSync(fakeDockerDir);
    const fakeCommand = join(binDir, 'command');
    writeFileSync(fakeCommand, `#!/bin/sh\necho ${fakeDockerDir}\n`);
    chmodSync(fakeCommand, 0o755);
    try {
      process.env.PATH = `${binDir}:${originalPath}`;
      assert.throws(
        () => resolveContainerRuntime('docker'),
        /CONTAINER_RUNTIME_NOT_FILE/,
        'must reject a non-regular container runtime',
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
