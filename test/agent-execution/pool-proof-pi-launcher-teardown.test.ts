import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePersistentContainerDriver, createPoolProofPiLauncher } from '../../src/domains/agent-execution/index.ts';
import { brokerSetup, buildMarker, hostIdentity, makeBrokerLauncher, makeExpectations, makeFakePiScript, makeIdentityDirs, makeJob, writeExitPi } from './pool-proof-pi-launcher.fixtures.ts';

describe('Launcher broker/container teardown is awaited on every terminal path (AC-10)', () => {
  it('removes provider runtime artifacts when sandbox preparation fails after auth setup', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-prep-cleanup-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const workspacePath = realpathSync(mkdtempSync(join(runtimeRoot, 'ws-')));
      const piPath = writeExitPi(runtimeRoot, 0);
      const expectations = makeExpectations(workspacePath, piPath, identity);
      mkdirSync(expectations.piRuntimeParent, { recursive: true });
      writeFileSync(join(expectations.piRuntimeParent, 'auth.json'), '{}');
      writeFileSync(join(expectations.piRuntimeParent, 'models.json'), '{}');
      const launcher = createPoolProofPiLauncher({
        expectations,
        job: makeJob(),
        verifyPackageAndProfile: identity.verify,
        brokerOptions: {
          socketPath: join(runtimeRoot, 'broker.sock'), workspacePath, containerRuntime: 'docker',
          image: 'sha256:' + 'a'.repeat(64), sandboxIdentity: { uid: 0, gid: 0, isPinned: false },
          cpuLimit: '1', memoryLimit: '512m', pidsLimit: 64, driver: createFakePersistentContainerDriver(),
        },
      });
      const result = await launcher.launch(buildMarker(expectations));
      assert.ok('code' in result);
      assert.equal(result.code, 'POOL_PROOF_LAUNCHER_MISMATCH');
      assert.equal(existsSync(join(expectations.piRuntimeParent, 'auth.json')), false);
      assert.equal(existsSync(join(expectations.piRuntimeParent, 'models.json')), false);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('removes provider runtime artifacts when broker start rejects', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-start-cleanup-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const workspacePath = realpathSync(mkdtempSync(join(runtimeRoot, 'ws-')));
      const piPath = writeExitPi(runtimeRoot, 0);
      const expectations = makeExpectations(workspacePath, piPath, identity);
      mkdirSync(expectations.piRuntimeParent, { recursive: true });
      writeFileSync(join(expectations.piRuntimeParent, 'auth.json'), '{}');
      writeFileSync(join(expectations.piRuntimeParent, 'models.json'), '{}');
      const driver = createFakePersistentContainerDriver({ failSpawn: true });
      const launcher = createPoolProofPiLauncher({
        expectations,
        job: makeJob(),
        verifyPackageAndProfile: identity.verify,
        brokerOptions: {
          socketPath: join(runtimeRoot, 'broker.sock'), workspacePath, containerRuntime: 'docker',
          image: 'sha256:' + 'a'.repeat(64), sandboxIdentity: hostIdentity(),
          cpuLimit: '1', memoryLimit: '512m', pidsLimit: 64, driver,
        },
      });
      await assert.rejects(() => launcher.launch(buildMarker(expectations)));
      assert.equal(existsSync(join(expectations.piRuntimeParent, 'auth.json')), false);
      assert.equal(existsSync(join(expectations.piRuntimeParent, 'models.json')), false);
      assert.equal(driver.removedIds.length, 0);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('awaits container teardown on normal Worker exit before launch resolves', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-teardown-ok-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const bs = brokerSetup(runtimeRoot);
      const piPath = writeExitPi(runtimeRoot, 0);
      const launcher = makeBrokerLauncher({ ...bs, runtimeRoot, piPath, identity });
      const launched = await launcher.launch(buildMarker(makeExpectations(bs.workspacePath, piPath, identity)));
      assert.ok(!('code' in launched), 'launch must succeed');
      if ('code' in launched) return;
      assert.equal(launched.exitCode, 0);
      assert.equal(bs.driver.spawnCount, 1, 'broker started one container');
      assert.equal(bs.driver.removedIds.length, 1, 'container must be removed before launch resolves');
      assert.equal(bs.driver.removedIds[0], bs.driver.lastContainerId);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('awaits container teardown on nonzero Worker exit', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-teardown-nz-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const bs = brokerSetup(runtimeRoot);
      const piPath = writeExitPi(runtimeRoot, 1);
      const launcher = makeBrokerLauncher({ ...bs, runtimeRoot, piPath, identity });
      const launched = await launcher.launch(buildMarker(makeExpectations(bs.workspacePath, piPath, identity)));
      assert.ok(!('code' in launched));
      if ('code' in launched) return;
      assert.notEqual(launched.exitCode, 0);
      assert.equal(bs.driver.removedIds.length, 1, 'nonzero exit must still tear down the container');
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('awaits container teardown on launcher timeout', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-teardown-to-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const bs = brokerSetup(runtimeRoot);
      const piPath = makeFakePiScript(runtimeRoot, { timeoutMs: 60_000, includePrompt: 'Attempt contract' });
      const launcher = makeBrokerLauncher({ ...bs, runtimeRoot, piPath, identity, timeoutMs: 50 });
      const launched = await launcher.launch(buildMarker(makeExpectations(bs.workspacePath, piPath, identity)));
      assert.ok(!('code' in launched));
      if ('code' in launched) return;
      assert.equal(launched.timedOut, true);
      assert.equal(bs.driver.removedIds.length, 1, 'timeout path must tear down the container');
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('awaits container teardown on injected Worker termination', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-teardown-inj-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const bs = brokerSetup(runtimeRoot);
      const piPath = makeFakePiScript(runtimeRoot, { timeoutMs: 60_000, includePrompt: 'Attempt contract' });
      const launcher = makeBrokerLauncher({ ...bs, runtimeRoot, piPath, identity, injectFault: true });
      const launched = await launcher.launch(buildMarker(makeExpectations(bs.workspacePath, piPath, identity)));
      assert.ok(!('code' in launched));
      if ('code' in launched) return;
      assert.equal(launched.failureCode, 'INJECTED_WORKER_FAILURE');
      assert.equal(bs.driver.removedIds.length, 1, 'injected-termination path must tear down the container');
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('broker-start failure rejects launch and leaks no container', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-teardown-bfail-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const workspacePath = realpathSync(mkdtempSync(join(runtimeRoot, 'ws-')));
      const socketPath = join(runtimeRoot, `broker-${Math.random().toString(36).slice(2)}.sock`);
      const driver = createFakePersistentContainerDriver({ failSpawn: true });
      const piPath = writeExitPi(runtimeRoot, 0);
      const expectations = makeExpectations(workspacePath, piPath, identity);
      const launcher = createPoolProofPiLauncher({
        expectations,
        job: makeJob(),
        verifyPackageAndProfile: identity.verify,
        brokerOptions: {
          socketPath, workspacePath, containerRuntime: 'docker',
          image: 'sha256:' + 'a'.repeat(64), sandboxIdentity: hostIdentity(),
          cpuLimit: '1', memoryLimit: '512m', pidsLimit: 64, driver,
        },
      });
      await assert.rejects(() => launcher.launch(buildMarker(expectations)));
      assert.equal(driver.removedIds.length, 0, 'no container was ever created, so none leaks');
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('launch settles deterministically when owned container removal fails on Worker exit', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-rm-fail-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const workspacePath = realpathSync(mkdtempSync(join(runtimeRoot, 'ws-')));
      const socketPath = join(runtimeRoot, `broker-${Math.random().toString(36).slice(2)}.sock`);
      // Removal fails on every teardown attempt (B3 surfaces a bounded error;
      // the launcher must still settle rather than leave launch pending).
      const driver = createFakePersistentContainerDriver({ removeRejects: true });
      const piPath = writeExitPi(runtimeRoot, 0);
      const expectations = makeExpectations(workspacePath, piPath, identity);
      const launcher = createPoolProofPiLauncher({
        expectations,
        job: makeJob(),
        verifyPackageAndProfile: identity.verify,
        brokerOptions: {
          socketPath, workspacePath, containerRuntime: 'docker',
          image: 'sha256:' + 'a'.repeat(64), sandboxIdentity: hostIdentity(),
          cpuLimit: '1', memoryLimit: '512m', pidsLimit: 64, driver,
        },
      });
      // Must resolve (not hang) even though container removal rejects.
      const settled = await Promise.race([
        launcher.launch(buildMarker(expectations)).then((r) => r),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch hung on removal failure')), 15_000)),
      ]);
      assert.ok(!('code' in settled), `launch must succeed when removal fails: ${(settled as { code: string }).code}`);
      if ('code' in settled) return;
      assert.equal(settled.exitCode, 0, 'Worker exit outcome is still reported');
      assert.equal(driver.removedIds.length, 0, 'failed removal records no successful removal');
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('peer-safe concurrent attempts keep distinct containers; tearing one down does not remove the other', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'launcher-teardown-peer-'));
    try {
      const identity = makeIdentityDirs(runtimeRoot);
      const bsA = brokerSetup(runtimeRoot);
      const bsB = brokerSetup(runtimeRoot);
      const piPath = writeExitPi(runtimeRoot, 0);
      const launcherA = makeBrokerLauncher({ ...bsA, runtimeRoot, piPath, identity });
      const launcherB = makeBrokerLauncher({ ...bsB, runtimeRoot, piPath, identity });
      const [a, b] = await Promise.all([
        launcherA.launch(buildMarker(makeExpectations(bsA.workspacePath, piPath, identity))),
        launcherB.launch(buildMarker(makeExpectations(bsB.workspacePath, piPath, identity))),
      ]);
      assert.ok(!('code' in a) && !('code' in b));
      assert.equal(bsA.driver.lastContainerId !== bsB.driver.lastContainerId, true, 'concurrent attempts get distinct containers');
      assert.equal(bsA.driver.removedIds.length, 1);
      assert.equal(bsB.driver.removedIds.length, 1);
      assert.equal(bsA.driver.removedIds[0], bsA.driver.lastContainerId, 'each teardown removes only its own owned id');
      assert.equal(bsB.driver.removedIds[0], bsB.driver.lastContainerId);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
