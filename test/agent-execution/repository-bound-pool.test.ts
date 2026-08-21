import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createRepositoryBoundExecution,
  createRepositoryBoundPool,
  createRepositoryBoundTaskContent,
} from '../../src/domains/agent-execution/repository-bound-pool.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repository-bound-pool-'));
  const poolHome = join(root, 'pool'); const runtimeRoot = join(poolHome, 'runtime'); const repositoryRoot = join(root, 'repo'); const persistentReviewCheckout = join(root, 'review');
  for (const path of [poolHome, runtimeRoot, repositoryRoot, persistentReviewCheckout]) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
  writeFileSync(join(repositoryRoot, 'README.md'), 'fixture\n');
  writeFileSync(join(persistentReviewCheckout, 'README.md'), 'review\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  execFileSync('git', ['init', '-q'], { cwd: repositoryRoot, env });
  execFileSync('git', ['add', '.'], { cwd: repositoryRoot, env });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repositoryRoot, env });
  execFileSync('git', ['init', '-q'], { cwd: persistentReviewCheckout, env });
  execFileSync('git', ['add', '.'], { cwd: persistentReviewCheckout, env });
  execFileSync('git', ['commit', '-qm', 'review'], { cwd: persistentReviewCheckout, env });
  return { root, poolHome, runtimeRoot, repositoryRoot, persistentReviewCheckout };
}
function gitTopLevel(root: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
}
function raw(paths: ReturnType<typeof fixture>) {
  return { poolHome: paths.poolHome, runtimeRoot: paths.runtimeRoot, repositoryRoot: paths.repositoryRoot, persistentReviewCheckout: paths.persistentReviewCheckout, baseRef: 'refs/heads/main', allowedChangedPaths: ['src/'], verificationCommands: [['npm', 'test']], model: 'openai-codex/gpt-5.6-sol', bounds: { verificationTimeoutSeconds: 60, launchTimeoutSeconds: 60 } };
}
describe('repository-bound pool', () => {
  it('freezes fixed policy and produces an immutable resolved execution', () => {
    const paths = fixture();
    try {
      const pool = createRepositoryBoundPool(raw(paths), gitTopLevel);
      const task = createRepositoryBoundTaskContent({ taskId: 'task-1', intent: 'change', changeSpec: 'implement it', acceptanceCriteria: [{ id: 'a', text: 'works' }] });
      const execution = createRepositoryBoundExecution(pool, task, () => 'a'.repeat(40));
      assert.equal(execution.baseCommit, 'a'.repeat(40));
      assert.equal(Object.isFrozen(execution), true);
      assert.equal(Object.isFrozen(execution.allowedChangedPaths), true);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it('rejects hostile owner configuration before Git identity resolution', () => {
    const paths = fixture();
    try {
      const cases: readonly [string, (value: Record<string, unknown>) => void, number][] = [
        ['unknown field', (value) => { value.unexpected = true; }, 0],
        ['credential field', (value) => { value.apiToken = 'secret'; }, 0],
        ['invalid model', (value) => { value.model = 'unknown/model'; }, 2],
        ['invalid bounds', (value) => { value.bounds = { verificationTimeoutSeconds: 59, launchTimeoutSeconds: 60 }; }, 2],
        ['worker-owned review', (value) => { value.persistentReviewCheckout = paths.poolHome; }, 2],
      ];
      for (const [name, mutate, expectedCalls] of cases) {
        const config = raw(paths) as Record<string, unknown>; mutate(config);
        let calls = 0;
        assert.throws(() => createRepositoryBoundPool(config, (root) => { calls += 1; return gitTopLevel(root); }), /REPOSITORY_BOUND_POOL_INVALID/, name);
        assert.equal(calls, expectedCalls, name);
      }
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it('accepts the canonical repository worktree as the persistent host review checkout', () => {
    const paths = fixture();
    try {
      const configured = raw(paths); configured.persistentReviewCheckout = paths.repositoryRoot;
      const pool = createRepositoryBoundPool(configured, gitTopLevel);
      assert.equal(pool.repositoryRoot, pool.persistentReviewCheckout);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it('rejects hostile config before invoking the Git identity seam', () => {
    const paths = fixture();
    try {
      for (const mutate of [
        (value: ReturnType<typeof raw>) => { delete (value as Partial<typeof value>).persistentReviewCheckout; },
      ]) {
        const value = raw(paths); let calls = 0; mutate(value);
        assert.throws(() => createRepositoryBoundPool(value, (root) => { calls++; return gitTopLevel(root); }), /REPOSITORY_BOUND_POOL_INVALID/);
        assert.equal(calls, 0);
      }
      assert.throws(() => createRepositoryBoundTaskContent({ taskId: 'task-1', intent: 'x', changeSpec: 'x', acceptanceCriteria: [{ id: 'a', text: 'x' }], repositoryRoot: paths.repositoryRoot }), /REPOSITORY_BOUND_POOL_INVALID/);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it('rejects mutable or non-branch refs and non-immutable resolver output', () => {
    const paths = fixture();
    try {
      const invalid = raw(paths); invalid.baseRef = 'main';
      assert.throws(() => createRepositoryBoundPool(invalid, gitTopLevel), /REPOSITORY_BOUND_POOL_INVALID/);
      const pool = createRepositoryBoundPool(raw(paths), gitTopLevel);
      const task = createRepositoryBoundTaskContent({ taskId: 'task-1', intent: 'x', changeSpec: 'x', acceptanceCriteria: [{ id: 'a', text: 'x' }] });
      assert.throws(() => createRepositoryBoundExecution(pool, task, () => 'main'), /REPOSITORY_BOUND_POOL_INVALID/);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
});
