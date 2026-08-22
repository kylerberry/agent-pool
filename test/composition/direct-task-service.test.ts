import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSqliteStore } from '../../src/domains/orchestration/index.ts';
import { createDirectTaskService } from '../../src/composition/direct-task-service.ts';
import { isRejection } from '../../src/domains/work-intake/contracts.ts';
import type { PiLauncher, PiProcess, PoolProofLaunchExpectations, ProofJob } from '../../src/domains/agent-execution/index.ts';
import type { GreenEvidence } from '../../src/domains/verification/pool-proof-verifier.ts';
import type { TaskRunSandboxCommand } from '../../src/composition/task-runner.ts';
import { staticModuleReferences, assertNoModuleReferences } from '../helpers/import-policy.ts';

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

function makeTaskRepo(root: string): { readonly repoPath: string; readonly baseCommit: string } {
  const repoPath = join(root, 'task-repo');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, '.gitignore'), '.home/\n');
  writeFileSync(join(repoPath, 'src', 'message.js'), "export function getMessage() {\n  return 'hello';\n}\n");
  mkdirSync(join(repoPath, 'test'), { recursive: true });
  writeFileSync(
    join(repoPath, 'test', 'message.test.js'),
    'import assert from "node:assert/strict";\nimport { getMessage } from "../src/message.js";\nassert.equal(getMessage(), "hello");\n',
  );
  assert.equal(git(repoPath, ['init', '-q']).status, 0);
  assert.equal(git(repoPath, ['add', '.']).status, 0);
  assert.equal(git(repoPath, ['commit', '-qm', 'task base']).status, 0);
  const baseCommit = String(git(repoPath, ['rev-parse', 'HEAD']).stdout).trim();
  assert.match(baseCommit, /^[0-9a-f]{40}$/);
  return { repoPath, baseCommit };
}

function greenWorker(workspacePath: string): void {
  writeFileSync(join(workspacePath, 'src', 'message.js'), "export function getMessage() {\n  return 'world';\n}\n");
  assert.equal(git(workspacePath, ['add', 'src/message.js']).status, 0);
  assert.equal(git(workspacePath, ['commit', '-qm', 'task change']).status, 0);
}

function fakeSandbox(allowed: readonly (readonly string[])[]): TaskRunSandboxCommand {
  const allowedCommands = allowed.map((c) => JSON.stringify(c));
  return async (_workspacePath, command): Promise<GreenEvidence> => ({
    command,
    exitCode: allowedCommands.includes(JSON.stringify(command)) ? 0 : 1,
    stdout: '',
    stderr: '',
    timedOut: false,
  });
}

function fakeLauncher(
  launches: { readonly attemptId: string; readonly workspacePath: string }[],
): (expectations: PoolProofLaunchExpectations, job: ProofJob) => PiLauncher {
  return (expectations, job): PiLauncher => ({
    launch: async (marker: unknown): Promise<PiProcess> => {
      greenWorker(expectations.workspacePath);
      launches.push({ attemptId: job.attemptId, workspacePath: expectations.workspacePath });
      const nonce =
        typeof marker === 'object' && marker !== null && 'attempt_nonce' in marker
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

function unit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a',
    intent: 'Make one approved change to the demo task repository.',
    change_spec: 'Update src/message.js so the verification command passes.',
    acceptance_criteria: ['Only allowed paths change.', 'All verification commands pass after the change.'],
    ...overrides,
  };
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function ownerOnlyRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

describe('compose-direct-intake-to-execution', () => {
  it('persists one authenticated unit and replays the original identity after store reopen', async () => {
    const runtimeRoot = ownerOnlyRoot('direct-task-replay-');
    const repoRoot = ownerOnlyRoot('direct-task-repo-');
    try {
      const repo = makeTaskRepo(repoRoot);
      const launches: { readonly attemptId: string; readonly workspacePath: string }[] = [];
      const store = await createSqliteStore({ runtimeRoot, dbLocation: 'direct-task.db' });
      const service = createDirectTaskService({
        store,
        authenticate: () => ({ authenticated: true, callerId: 'caller-1' }),
        generateSubmissionId: (() => {
          let n = 0;
          return () => `sub-${++n}`;
        })(),
        taskSettings: {
          task_id: 'demo-task',
          target_repo_path: repo.repoPath,
          base_commit: repo.baseCommit,
          allowed_changed_paths: ['src/message.js'],
          verification_commands: [['node', '--test', 'test/message.test.js']],
          model: 'moonshot/kimi-k2.7-code',
          bounds: { verification_timeout_seconds: 60 },
        },
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
        adapterOverrides: {
          createPiLauncher: fakeLauncher(launches),
          runSandboxCommand: fakeSandbox([['node', '--test', 'test/message.test.js']]),
        },
        preflight: {
          pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
          package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
          profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
          sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
          gitPath: gitPath(),
        },
        containerRuntime: 'docker',
        sandboxImage: 'sha256:fake',
      });

      const headers = { 'Idempotency-Key': 'k1', authorization: 'Bearer test' };
      const body = { repo: 'owner/repo', branch: 'main', unit: unit() };
      const first = await service.handleRequest({ method: 'POST', path: '/tasks', headers, body });
      assert.equal(first.status, 202);
      const firstBody = first.body as { submission_id: string; work_id: string; replayed: boolean };
      assert.equal(firstBody.replayed, false);
      assert.equal(typeof firstBody.submission_id, 'string');
      assert.equal(typeof firstBody.work_id, 'string');
      assert.notEqual(firstBody.submission_id, firstBody.work_id);

      await store.close();
      const reopened = await createSqliteStore({ runtimeRoot, dbLocation: 'direct-task.db' });
      const replayService = createDirectTaskService({
        store: reopened,
        authenticate: () => ({ authenticated: true, callerId: 'caller-1' }),
        generateSubmissionId: () => 'sub-SHOULD-NOT-BE-USED',
        taskSettings: {
          task_id: 'demo-task',
          target_repo_path: repo.repoPath,
          base_commit: repo.baseCommit,
          allowed_changed_paths: ['src/message.js'],
          verification_commands: [['node', '--test', 'test/message.test.js']],
          model: 'moonshot/kimi-k2.7-code',
          bounds: { verification_timeout_seconds: 60 },
        },
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
        adapterOverrides: {
          createPiLauncher: fakeLauncher(launches),
          runSandboxCommand: fakeSandbox([['node', '--test', 'test/message.test.js']]),
        },
        preflight: {
          pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
          package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
          profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
          sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
          gitPath: gitPath(),
        },
        containerRuntime: 'docker',
        sandboxImage: 'sha256:fake',
      });

      const second = await replayService.handleRequest({ method: 'POST', path: '/tasks', headers, body });
      assert.equal(second.status, 200);
      const secondBody = second.body as { submission_id: string; work_id: string; replayed: boolean };
      assert.equal(secondBody.replayed, true);
      assert.equal(secondBody.submission_id, firstBody.submission_id);
      assert.equal(secondBody.work_id, firstBody.work_id);

      const conflict = await replayService.handleRequest({
        method: 'POST',
        path: '/tasks',
        headers,
        body: { repo: 'owner/repo', branch: 'main', unit: unit({ change_spec: 'something else' }) },
      });
      assert.equal(conflict.status, 409);

      const otherCaller = createDirectTaskService({
        store: reopened,
        authenticate: () => ({ authenticated: true, callerId: 'caller-2' }),
        generateSubmissionId: () => 'sub-other',
        taskSettings: {
          task_id: 'demo-task',
          target_repo_path: repo.repoPath,
          base_commit: repo.baseCommit,
          allowed_changed_paths: ['src/message.js'],
          verification_commands: [['node', '--test', 'test/message.test.js']],
          model: 'moonshot/kimi-k2.7-code',
          bounds: { verification_timeout_seconds: 60 },
        },
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
        adapterOverrides: {
          createPiLauncher: fakeLauncher(launches),
          runSandboxCommand: fakeSandbox([['node', '--test', 'test/message.test.js']]),
        },
        preflight: {
          pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
          package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
          profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
          sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
          gitPath: gitPath(),
        },
        containerRuntime: 'docker',
        sandboxImage: 'sha256:fake',
      });
      const other = await otherCaller.handleRequest({ method: 'POST', path: '/tasks', headers, body });
      assert.equal(other.status, 202);
      assert.notEqual((other.body as { submission_id: string }).submission_id, firstBody.submission_id);

      const unauth = createDirectTaskService({
        store: reopened,
        authenticate: () => ({ authenticated: false }),
        generateSubmissionId: () => 'nope',
        taskSettings: {
          task_id: 'demo-task',
          target_repo_path: repo.repoPath,
          base_commit: repo.baseCommit,
          allowed_changed_paths: ['src/message.js'],
          verification_commands: [['node', '--test', 'test/message.test.js']],
          model: 'moonshot/kimi-k2.7-code',
          bounds: { verification_timeout_seconds: 60 },
        },
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
        adapterOverrides: {
          createPiLauncher: fakeLauncher(launches),
          runSandboxCommand: fakeSandbox([['node', '--test', 'test/message.test.js']]),
        },
        preflight: {
          pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
          package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
          profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
          sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
          gitPath: gitPath(),
        },
        containerRuntime: 'docker',
        sandboxImage: 'sha256:fake',
      });
      const denied = await unauth.handleRequest({ method: 'POST', path: '/tasks', headers, body });
      assert.equal(denied.status, 401);

      const dag = await replayService.handleRequest({
        method: 'POST',
        path: '/tasks',
        headers: { authorization: 'Bearer test' },
        body: { repo: 'owner/repo', branch: 'main', units: [unit({ id: 'a' }), unit({ id: 'b', depends_on: ['a'] })] },
      });
      assert.equal(dag.status, 400);
      assert.equal(isRejection(dag.body as never), true);

      await reopened.close();
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('recovers pending work after process restart and launches one fresh Worker', async () => {
    const runtimeRoot = ownerOnlyRoot('direct-task-claim-');
    const repoRoot = ownerOnlyRoot('direct-task-repo-');
    const launches: { readonly attemptId: string; readonly workspacePath: string }[] = [];
    try {
      const repo = makeTaskRepo(repoRoot);
      const settings = {
        task_id: 'demo-task',
        target_repo_path: repo.repoPath,
        base_commit: repo.baseCommit,
        allowed_changed_paths: ['src/message.js'],
        verification_commands: [['node', '--test', 'test/message.test.js']],
        model: 'moonshot/kimi-k2.7-code' as const,
        bounds: { verification_timeout_seconds: 60 },
      };
      const preflight = {
        pi: { path: '/fake/pi', version: '0.84.1', digest: 'a'.repeat(64) },
        package: { path: '/fake/package', profile: 'pool-proof-builder', digest: 'b'.repeat(64) },
        profile: { name: 'pool-proof-builder', path: '/fake/profile', digest: 'c'.repeat(64) },
        sandboxImage: { image: 'sha256:fake', runtime: 'docker', verified: true },
        gitPath: gitPath(),
      };
      const store = await createSqliteStore({ runtimeRoot, dbLocation: 'direct-task.db' });
      const service = createDirectTaskService({
        store,
        authenticate: () => ({ authenticated: true, callerId: 'caller-1' }),
        generateSubmissionId: () => 'sub-1',
        taskSettings: settings,
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
        adapterOverrides: {
          createPiLauncher: fakeLauncher(launches),
          runSandboxCommand: fakeSandbox([['node', '--test', 'test/message.test.js']]),
        },
        preflight,
        containerRuntime: 'docker',
        sandboxImage: 'sha256:fake',
      });
      const posted = await service.handleRequest({
        method: 'POST',
        path: '/tasks',
        headers: { 'Idempotency-Key': 'k1' },
        body: { repo: 'owner/repo', branch: 'main', unit: unit() },
      });
      assert.equal(posted.status, 202);
      const submissionId = (posted.body as { submission_id: string }).submission_id;
      await store.close();
      assert.equal(launches.length, 0);

      const reopened = await createSqliteStore({ runtimeRoot, dbLocation: 'direct-task.db' });
      const resumed = createDirectTaskService({
        store: reopened,
        authenticate: () => ({ authenticated: true, callerId: 'caller-1' }),
        generateSubmissionId: () => 'sub-unused',
        taskSettings: settings,
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
        adapterOverrides: {
          createPiLauncher: fakeLauncher(launches),
          runSandboxCommand: fakeSandbox([['node', '--test', 'test/message.test.js']]),
        },
        preflight,
        containerRuntime: 'docker',
        sandboxImage: 'sha256:fake',
      });
      await resumed.claimOnce();
      assert.equal(launches.length, 1);

      const status = await resumed.handleRequest({
        method: 'GET',
        path: `/tasks/${submissionId}`,
        headers: {},
        body: undefined,
      });
      assert.equal(status.status, 200);
      const projection = status.body as {
        submission_id: string;
        work_id: string;
        node_id: string;
        status: string;
        attempt: { attempt_id: string } | null;
        result: { result_id: string; status: string; commit_present: boolean; checks: readonly { name: string; passed: boolean }[] } | null;
        caller_id?: unknown;
        token?: unknown;
        target_repo_path?: unknown;
        verification_commands?: unknown;
      };
      assert.equal(projection.submission_id, submissionId);
      assert.equal(projection.status, 'passed');
      assert.equal(projection.attempt?.attempt_id, launches[0]?.attemptId);
      assert.equal(projection.result?.status, 'passed');
      assert.equal(projection.result?.commit_present, true);
      assert.equal('caller_id' in projection, false);
      assert.equal('token' in projection, false);
      assert.equal('target_repo_path' in projection, false);
      assert.equal('verification_commands' in projection, false);

      const stranger = createDirectTaskService({
        store: reopened,
        authenticate: () => ({ authenticated: true, callerId: 'caller-2' }),
        generateSubmissionId: () => 'x',
        taskSettings: settings,
        adapterProvenance: { launcher: 'fake', sandbox: 'fake', verifier: 'real', persistence: 'real' },
        adapterOverrides: {
          createPiLauncher: fakeLauncher(launches),
          runSandboxCommand: fakeSandbox([['node', '--test', 'test/message.test.js']]),
        },
        preflight,
        containerRuntime: 'docker',
        sandboxImage: 'sha256:fake',
      });
      const hidden = await stranger.handleRequest({
        method: 'GET',
        path: `/tasks/${submissionId}`,
        headers: {},
        body: undefined,
      });
      assert.equal(hidden.status, 404);

      await resumed.claimOnce();
      assert.equal(launches.length, 1, 'terminal work must not relaunch');
      await reopened.close();
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('cannot import decomposition or Gate 1 or the proof-only harness', () => {
    const compositionRoot = fileURLToPath(new URL('../../src/composition/', import.meta.url));
    const files = walkTs(compositionRoot);
    assert.ok(files.length > 0);
    for (const file of files) {
      assertNoModuleReferences(file, ['packages/pool-proof-harness', 'bullmq', 'ioredis', 'redis']);
      for (const ref of staticModuleReferences(file)) {
        assert.equal(ref.specifier.includes('decomposition-harness'), false, file);
        assert.equal(ref.specifier.includes('pool-proof-harness'), false, file);
      }
    }
    const source = walkTs(compositionRoot).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert.equal(/runDecomposition\(/.test(source), false);
    assert.equal(/gate1_required:\s*true/.test(source), false);
  });
});
