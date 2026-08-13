import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestTempDir } from './test-temp-dir.ts';
import { createPoolProofPiLauncher } from '../../src/domains/agent-execution/index.ts';
import { buildMarker, digestFile, makeExpectations, makeFakePiAuthDumpScript, makeFakePiIdentityCapsuleDumpScript, makeFakePiPromptDumpScript, makeFakePiScript, makeIdentityDirs, makeJob } from './pool-proof-pi-launcher.fixtures.ts';

describe('Pool Proof Pi Launcher', () => {
  it('enforces wall-clock timeout and cleans up', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { timeoutMs: 60_000, includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    const launcher = createPoolProofPiLauncher({
      expectations,
      job: makeJob(),
      timeoutMs: 50,
      verifyPackageAndProfile: identity.verify,
    });

    const now = new Date();
    const launched = await launcher.launch({
      schema_version: 3,
      actor: 'pool-worker',
      node_id: 'single-worker-pool-proof',
      attempt_id: 'att://proof/single-worker-pool-proof/1',
      attempt_nonce: 'b'.repeat(64),
      issued_by: 'agent-pool-runtime',
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 179_000).toISOString(),
      max_age_seconds: 180,
      target_repo: 'fixture',
      target_branch: 'main',
      workspace_path: fixturePath,
      pi_runtime_parent: expectations.piRuntimeParent,
      pi_session_dir: expectations.piSessionDir,
      pi_executable_identity: {
        path: piPath,
        version: '0.84.1',
        digest: digestFile(piPath),
      },
      package_identity: {
        path: identity.packagePath,
        profile: 'pool-proof-builder',
        digest: identity.packageDigest,
      },
      profile_identity: {
        name: 'pool-proof-builder',
        path: identity.profilePath,
        digest: identity.profileDigest,
      },
      selected_model: 'openai-codex/gpt-5.6-terra',
      tool_grants: ['read', 'edit', 'write', 'bash', 'actor_identity'],
      result_destination: { kind: 'sqlite', id: 'result-1' },
    });

    assert.ok('exitCode' in launched, `launch failed unexpectedly: ${(launched as { code: string; reason: string }).code}`);
    assert.notEqual(launched.exitCode, 0);
    assert.equal(launched.timedOut, true, 'timedOut must be true after launcher timeout');
    assert.equal(existsSync(join(expectations.piRuntimeParent, 'auth.json')), false, 'provider auth residue must be removed');
  });

  it('consumes a proof-only fault directive at launch and records the injected failure', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract', timeoutMs: 60_000 });
    const expectations = makeExpectations(fixturePath, piPath, identity);
    const attemptId = expectations.attemptId;

    const launcher = createPoolProofPiLauncher({
      expectations,
      job: makeJob(),
      verifyPackageAndProfile: identity.verify,
      injectFaultForAttemptId: attemptId,
    });

    const launched = await launcher.launch(buildMarker(expectations));
    assert.ok(!('code' in launched), 'launch must succeed');
    if ('code' in launched) return;

    assert.equal(launched.attemptId, attemptId);
    assert.equal(launched.signalCode, 'SIGTERM');
    assert.equal(launched.failureCode, 'INJECTED_WORKER_FAILURE');
    assert.ok(launched.pid > 0);
  });

  it('ignores a fault directive bound to a different attempt', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const expectations = makeExpectations(fixturePath, piPath, identity);

    const launcher = createPoolProofPiLauncher({
      expectations,
      job: makeJob(),
      verifyPackageAndProfile: identity.verify,
      injectFaultForAttemptId: 'att://proof/other/1',
    });

    const launched = await launcher.launch(buildMarker(expectations));
    assert.ok(!('code' in launched), 'launch must succeed');
    if ('code' in launched) return;

    assert.equal(launched.signalCode, null);
    assert.equal(launched.failureCode, null);
    assert.equal(launched.exitCode, 0);
  });

  it('does not kill a peer child when fault is bound to a different attempt', async (t) => {
    const runtimeRoot = createTestTempDir(t, 'launcher-');
    const fixturePath = createTestTempDir(t, 'fixture-');
    mkdirSync(join(fixturePath, 'src'), { recursive: true });
    const identity = makeIdentityDirs(runtimeRoot);
    const piPath = makeFakePiScript(runtimeRoot, { includePrompt: 'Attempt contract' });
    const peerExpectations = makeExpectations(fixturePath, piPath, identity);

    const peerLauncher = createPoolProofPiLauncher({
      expectations: peerExpectations,
      job: makeJob(),
      verifyPackageAndProfile: identity.verify,
      injectFaultForAttemptId: 'att://proof/other/1',
    });

    const peer = await peerLauncher.launch(buildMarker(peerExpectations));
    assert.ok(!('code' in peer), 'peer launch must succeed');
    if ('code' in peer) return;

    assert.equal(peer.signalCode, null);
    assert.equal(peer.failureCode, null);
    assert.equal(peer.exitCode, 0);
  });
});
