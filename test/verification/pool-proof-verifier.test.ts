import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPoolProofVerifier } from '../../src/domains/verification/pool-proof-verifier.ts';
import type { AttemptResources } from '../../src/domains/agent-execution/attempt-resources.ts';
import type { PiProcess } from '../../src/domains/agent-execution/pool-proof-pi-launcher.ts';

function makeResources(workspacePath: string): AttemptResources {
  return {
    attemptId: 'attempt-1',
    basePath: '/tmp/base',
    workspacePath,
    piRuntimeParent: '/tmp/pi',
    piSessionDir: '/tmp/pi/session',
    workspaceHome: '/workspace/.home',
    workspaceXdgConfig: '/workspace/.home/.config',
    workspaceXdgCache: '/workspace/.home/.cache',
    workspaceXdgData: '/workspace/.home/.local/share',
    nonce: 'a'.repeat(64),
    resultId: 'result-1',
    createdAt: new Date(),
  };
}

function makeProcess(): PiProcess {
  return {
    pid: 1,
    exitCode: 0,
    signalCode: null,
    timedOut: false,
    output: '',
    nodeId: 'n1',
    attemptId: 'a1',
    attemptNonce: 'a'.repeat(64),
    resultId: 'result-1',
    failureCode: null,
  };
}

function gitPath(): string {
  const result = spawnSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true });
  return result.status === 0 ? result.stdout.trim() : 'git';
}

function git(workspacePath: string, args: readonly string[], env?: Record<string, string>) {
  const result = spawnSync(gitPath(), args, {
    cwd: workspacePath,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: 'Pool Proof',
      GIT_AUTHOR_EMAIL: 'proof@agent-pool.local',
      GIT_COMMITTER_NAME: 'Pool Proof',
      GIT_COMMITTER_EMAIL: 'proof@agent-pool.local',
      ...env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result;
}

function setupRepo(workspacePath: string, changePath?: string, changeContent?: string): { baseCommit: string; headCommit: string } {
  mkdirSync(join(workspacePath, 'src'), { recursive: true });
  mkdirSync(join(workspacePath, 'test'), { recursive: true });
  writeFileSync(join(workspacePath, 'src/message.js'), "export function getMessage() { return 'hello'; }");
  writeFileSync(
    join(workspacePath, 'test/message.test.js'),
    `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { getMessage } from '../src/message.js'; test('msg', () => assert.equal(getMessage(), 'world'));`,
  );
  writeFileSync(join(workspacePath, 'package.json'), JSON.stringify({ type: 'module' }));

  git(workspacePath, ['init']);
  git(workspacePath, ['config', 'user.name', 'Pool Proof']);
  git(workspacePath, ['config', 'user.email', 'proof@agent-pool.local']);
  git(workspacePath, ['add', '.']);
  git(workspacePath, ['commit', '-m', 'Base commit', '--date', '2026-08-05T00:00:00Z']);
  const baseCommit = git(workspacePath, ['rev-parse', 'HEAD']).stdout.trim();

  if (changePath && changeContent !== undefined) {
    writeFileSync(join(workspacePath, changePath), changeContent);
    git(workspacePath, ['add', changePath]);
    git(workspacePath, ['commit', '-m', 'Attempt commit', '--date', '2026-08-05T00:01:00Z']);
  }
  const headCommit = git(workspacePath, ['rev-parse', 'HEAD']).stdout.trim();
  return { baseCommit, headCommit };
}

function makeVerifier(fixtureOk: boolean) {
  return createPoolProofVerifier({
    gitPath: gitPath(),
    fixtureTestRunner: async (_cwd, command) => {
      // Isolation probes should report failure (exit nonzero) in a real sandbox.
      const isProbe = command.length >= 2 && command[0] === 'sh' && command[1] === '-c';
      return {
        command,
        exitCode: isProbe ? 1 : fixtureOk ? 0 : 1,
        stdout: '',
        stderr: '',
        timedOut: false,
      };
    },
    hasConflictingResult: async () => ({ hasConflict: false, existingResultId: null }),
  });
}

describe('Pool Proof Verifier', () => {
  it('passes when all checks succeed', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-'));
    const { baseCommit, headCommit } = setupRepo(
      workspacePath,
      'src/message.js',
      "export function getMessage() { return 'world'; }",
    );
    const verifier = makeVerifier(true);
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: baseCommit,
      },
      makeProcess(),
    );
    assert.equal(result.status, 'passed');
    assert.equal(result.commitSha, headCommit);
  });

  it('fails when exit code is non-zero', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-'));
    setupRepo(workspacePath);
    const verifier = makeVerifier(true);
    const result = await verifier.verify(
      makeResources(workspacePath),
      { nodeId: 'n1', attemptId: 'a1', allowedChangedPaths: [], fixtureTestCommand: ['node'] },
      { ...makeProcess(), exitCode: 1 },
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.commitSha, null, 'a failed verdict must not retain the fixture base HEAD');
    const check = result.checks.find((c) => c.name === 'process_exit_success');
    assert.equal(check?.passed, false);
  });

  it('fails when changed paths are outside the manifest', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-'));
    setupRepo(workspacePath, 'src/secret.js', 'secret');
    const verifier = makeVerifier(true);
    const result = await verifier.verify(
      makeResources(workspacePath),
      { nodeId: 'n1', attemptId: 'a1', allowedChangedPaths: ['src/message.js'], fixtureTestCommand: ['node'] },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    const check = result.checks.find((c) => c.name === 'allowed_paths_only');
    assert.equal(check?.passed, false);
  });

  it('fails when parent is not the expected base commit', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-'));
    setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    const verifier = makeVerifier(true);
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.commitSha, null);
    const check = result.checks.find((c) => c.name === 'expected_parent');
    assert.equal(check?.passed, false);
  });

  it('fails when working tree is dirty', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-'));
    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    writeFileSync(join(workspacePath, 'untracked.txt'), 'dirty');
    const verifier = makeVerifier(true);
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: baseCommit,
      },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    const check = result.checks.find((c) => c.name === 'clean_tree');
    assert.equal(check?.passed, false);
  });

  it('fails when process binding is wrong', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-'));
    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    const verifier = makeVerifier(true);
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: baseCommit,
      },
      { ...makeProcess(), attemptId: 'wrong' },
    );
    assert.equal(result.status, 'failed');
    const check = result.checks.find((c) => c.name === 'process_attempt_binding');
    assert.equal(check?.passed, false);
  });

  it('fails when a conflicting result exists', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-'));
    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    const verifier = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async (_cwd, command) => ({
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }),
      hasConflictingResult: async () => ({ hasConflict: true, existingResultId: 'other-result' }),
    });
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: baseCommit,
      },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    const check = result.checks.find((c) => c.name === 'no_conflicting_result');
    assert.equal(check?.passed, false);
  });

  it('turns fixture runner rejection into deterministic failed evidence without raw errors', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-fixture-reject-'));
    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    const verifier = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async () => { throw new Error('fixture runner secret=do-not-leak'); },
      hasConflictingResult: async () => ({ hasConflict: false, existingResultId: null }),
    });
    const result = await verifier.verify(
      makeResources(workspacePath),
      { nodeId: 'n1', attemptId: 'a1', allowedChangedPaths: ['src/message.js'], fixtureTestCommand: ['node'], expectedParentCommit: baseCommit },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'FIXTURE_TEST_RUNNER_FAILED');
    assert.equal(result.checks.find((check) => check.name === 'fixture_test_passes')?.passed, false);
    assert.equal(result.greenEvidence, null);
    assert.ok(!JSON.stringify(result).includes('fixture runner secret=do-not-leak'));
  });

  it('turns isolation runner rejection into deterministic failed evidence without raw errors', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-isolation-reject-'));
    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    const verifier = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async (_cwd, command) => {
        if (command[0] === 'sh') throw new Error('isolation runner secret=do-not-leak');
        return { command, exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      hasConflictingResult: async () => ({ hasConflict: false, existingResultId: null }),
    });
    const result = await verifier.verify(
      makeResources(workspacePath),
      { nodeId: 'n1', attemptId: 'a1', allowedChangedPaths: ['src/message.js'], fixtureTestCommand: ['node'], expectedParentCommit: baseCommit },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'ISOLATION_RUNNER_FAILED');
    assert.equal(result.checks.find((check) => check.name === 'isolation_probes_pass')?.passed, false);
    assert.equal(result.greenEvidence, null);
    assert.ok(!JSON.stringify(result).includes('isolation runner secret=do-not-leak'));
  });

  it('turns fulfilled malformed collaborator values into deterministic failed evidence', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-malformed-collaborator-'));
    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    const job = { nodeId: 'n1', attemptId: 'a1', allowedChangedPaths: ['src/message.js'], fixtureTestCommand: ['node'], expectedParentCommit: baseCommit };
    const malformedFixture = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async () => undefined as never,
      hasConflictingResult: async () => ({ hasConflict: false, existingResultId: null }),
    });
    const fixtureResult = await malformedFixture.verify(makeResources(workspacePath), job, makeProcess());
    assert.equal(fixtureResult.status, 'failed');
    assert.equal(fixtureResult.failureCode, 'FIXTURE_TEST_RUNNER_FAILED');
    assert.equal(fixtureResult.checks.find((check) => check.name === 'fixture_test_passes')?.passed, false);
    assert.equal(fixtureResult.greenEvidence, null);

    const malformedIsolation = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async (_cwd, command) => command[0] === 'sh'
        ? ({ exitCode: 1 } as never)
        : ({ command, exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      hasConflictingResult: async () => ({ hasConflict: false, existingResultId: null }),
    });
    const isolationResult = await malformedIsolation.verify(makeResources(workspacePath), job, makeProcess());
    assert.equal(isolationResult.status, 'failed');
    assert.equal(isolationResult.failureCode, 'ISOLATION_RUNNER_FAILED');
    assert.equal(isolationResult.checks.find((check) => check.name === 'isolation_probes_pass')?.passed, false);
    assert.equal(isolationResult.greenEvidence, null);

    const malformedConflict = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async (_cwd, command) => ({ command, exitCode: command[0] === 'sh' ? 1 : 0, stdout: '', stderr: '', timedOut: false }),
      hasConflictingResult: async () => ({ hasConflict: 'no' } as never),
    });
    const conflictResult = await malformedConflict.verify(makeResources(workspacePath), job, makeProcess());
    assert.equal(conflictResult.status, 'failed');
    assert.equal(conflictResult.failureCode, 'CONFLICT_QUERY_FAILED');
    assert.equal(conflictResult.checks.find((check) => check.name === 'no_conflicting_result')?.passed, false);
    assert.equal(conflictResult.greenEvidence, null);
  });

  it('turns conflict query rejection into deterministic failed evidence without raw errors', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-conflict-reject-'));
    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");
    const verifier = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async (_cwd, command) => ({ command, exitCode: command[0] === 'sh' ? 1 : 0, stdout: '', stderr: '', timedOut: false }),
      hasConflictingResult: async () => { throw new Error('conflict query secret=do-not-leak'); },
    });
    const result = await verifier.verify(
      makeResources(workspacePath),
      { nodeId: 'n1', attemptId: 'a1', allowedChangedPaths: ['src/message.js'], fixtureTestCommand: ['node'], expectedParentCommit: baseCommit },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'CONFLICT_QUERY_FAILED');
    assert.equal(result.checks.find((check) => check.name === 'no_conflicting_result')?.passed, false);
    assert.equal(result.greenEvidence, null);
    assert.ok(!JSON.stringify(result).includes('conflict query secret=do-not-leak'));
  });

  it('rejects readable host/root credential exposure through default isolation probes', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-isolation-'));
    const { baseCommit } = setupRepo(
      workspacePath,
      'src/message.js',
      "export function getMessage() { return 'world'; }",
    );
    const verifier = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async (_cwd, command) => {
        const isProbe = command.length >= 2 && command[0] === 'sh' && command[1] === '-c';
        const probe = isProbe ? command[2] ?? '' : '';
        const exposesCredential =
          probe.includes('/root/.pi/agent/auth.json') ||
          probe.includes('/root/.ssh/id_rsa') ||
          probe.includes('/etc/shadow') ||
          probe.includes('$(id -u)') ||
          probe.includes('id -u');
        return {
          command,
          exitCode: isProbe ? (exposesCredential ? 0 : 1) : 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
      hasConflictingResult: async () => ({ hasConflict: false, existingResultId: null }),
    });
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: baseCommit,
      },
      makeProcess(),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.commitSha, null);
    const check = result.checks.find((c) => c.name === 'isolation_probes_pass');
    assert.equal(check?.passed, false);
  });

  it('does not fail isolation solely because /root directory exists', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-isolation-dir-'));
    const { baseCommit } = setupRepo(
      workspacePath,
      'src/message.js',
      "export function getMessage() { return 'world'; }",
    );
    const verifier = createPoolProofVerifier({
      gitPath: gitPath(),
      fixtureTestRunner: async (_cwd, command) => {
        const isProbe = command.length >= 2 && command[0] === 'sh' && command[1] === '-c';
        return {
          command,
          exitCode: isProbe ? 1 : 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
      hasConflictingResult: async () => ({ hasConflict: false, existingResultId: null }),
    });
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: baseCommit,
        isolationProbes: ['test -d /root'],
      },
      makeProcess(),
    );
    assert.equal(result.status, 'passed');
    const check = result.checks.find((c) => c.name === 'isolation_probes_pass');
    assert.equal(check?.passed, true);
  });

  it('ignores repo-local execution-capable git config', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'verify-hostile-'));
    const markerFile = join(tmpdir(), `hostile-marker-${Date.now()}`);
    const maliciousScript = join(tmpdir(), `hostile-fsmonitor-${Date.now()}.sh`);
    writeFileSync(maliciousScript, `#!/bin/sh\ntouch "${markerFile}"\n`, { mode: 0o755 });

    const { baseCommit } = setupRepo(workspacePath, 'src/message.js', "export function getMessage() { return 'world'; }");

    const configPath = join(workspacePath, '.git', 'config');
    const existing = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      `${existing}\n[core]\n\tfsmonitor = ${maliciousScript}\n\thooksPath = ${tmpdir()}\n[diff]\n\texternal = ${maliciousScript}\n`,
    );

    const verifier = makeVerifier(true);
    const result = await verifier.verify(
      makeResources(workspacePath),
      {
        nodeId: 'n1',
        attemptId: 'a1',
        allowedChangedPaths: ['src/message.js'],
        fixtureTestCommand: ['node', '--test', 'test/message.test.js'],
        expectedParentCommit: baseCommit,
      },
      makeProcess(),
    );

    assert.equal(result.status, 'passed');
    assert.equal(existsSync(markerFile), false, 'hostile git config must not execute during verifier reads');
  });
});
