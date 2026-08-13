/**
 * Persistent attempt sandbox lifecycle — lifecycle driver and public-interface
 * tests (fake driver). These prove the host-side state machine: one internally
 * owned container per sandbox, reused across runTool, fresh per instance, exact
 * direct runtime argv, isolation/resource/mount flags, idempotent teardown,
 * stale/foreign rejection, identifier/path/argument injection rejection, and no
 * exposure of container/PID/kill/exec-target primitives.
 *
 * Real-Docker evidence lives in packages/pool-proof-harness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRepositorySandbox,
  createPersistentContainerDriver,
  createFakePersistentContainerDriver,
  resolveRuntimeExecutable,
} from '../../src/domains/agent-execution/index.ts';
import { PINNED_IMAGE, baseOptions } from './repository-sandbox.fixtures.ts';

describe('Repository Sandbox lifecycle driver (fake driver)', () => {
  it('creates exactly one persistent container on start and reuses it for every runTool', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();

    await sandbox.runTool({ tool: 'write', path: 'a.txt', content: 'A' });
    await sandbox.runTool({ tool: 'read', path: 'a.txt' });
    await sandbox.runTool({ tool: 'bash', command: 'ls', args: [] });

    assert.equal(driver.spawnCount, 1, 'start must spawn exactly one persistent container');
    const session = driver.sessions[0]!;
    assert.equal(session.requestFrames.length, 3, 'every runTool reuses the same supervisor');
    assert.equal((session.requestFrames[0] as { tool?: string }).tool, 'write');

    await sandbox.stop();
  });

  it('start is idempotent and does not spawn a second container', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    await sandbox.start();
    assert.equal(driver.spawnCount, 1);
    await sandbox.stop();
  });

  it('rejects runTool before start with a deterministic error', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await assert.rejects(() => sandbox.runTool({ tool: 'read', path: 'a' } as never), /not started/i);
  });

  it('rejects runTool after stop and stop is idempotent', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    await sandbox.stop();
    await sandbox.stop();
    await assert.rejects(() => sandbox.runTool({ tool: 'read', path: 'a' } as never), /stopped|teardown|terminal/i);
  });

  it('removes only the owned container on stop and never another id', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const owned = driver.lastContainerId;
    assert.ok(owned);
    await sandbox.stop();
    assert.equal(driver.removedIds.length, 1);
    assert.equal(driver.removedIds[0], owned);
    // Repeated stop must not remove the same owned id again — one memoized
    // removal across start rollback, stop, terminal cleanup, and repeat stop.
    await sandbox.stop();
    assert.equal(driver.removedIds.length, 1, 'repeated stop must keep exactly one removal');
  });

  it('enforces exact direct runtime argv and all isolation/resource/mount flags', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const argv = driver.lastSpawnArgs;
    assert.ok(argv.includes('run'), 'must use run subcommand');
    assert.ok(argv.includes('--init'), 'must run an init/reaper as PID 1 so killed grandchildren/zombies are reaped');
    assert.ok(!argv.includes('--rm'), 'persistent container must not auto-remove on client exit');
    assert.ok(argv.includes('-i'), 'stdin must stay open for the persistent supervisor');
    assert.ok(argv.includes('--cidfile'), 'must capture owned container id to a cidfile');
    assert.ok(argv.includes('--network=none'));
    assert.ok(argv.includes('--privileged=false'));
    assert.ok(argv.includes('--security-opt=no-new-privileges'));
    assert.ok(argv.includes('--cap-drop=ALL'));
    assert.ok(argv.includes('--read-only'));
    assert.ok(argv.includes('--user'), 'must set non-root user');
    const userValue = argv[argv.indexOf('--user') + 1];
    assert.ok(userValue && !userValue.startsWith('0:'), 'must never run as uid 0');
    assert.ok(argv.some((a) => a === '--cpus' && argv[argv.indexOf(a) + 1] === '1'));
    assert.ok(argv.some((a) => a === '--memory' && argv[argv.indexOf(a) + 1] === '512m'));
    assert.ok(argv.some((a) => a === '--pids-limit'));
    assert.ok(argv.some((a) => a === '--tmpfs'));
    assert.ok(argv.some((a) => /^\/tmp:/.test(a)), 'tmpfs must mount /tmp');
    // Exactly one workspace mount; no host HOME, no Docker socket.
    const mounts = argv.filter((a) => a.includes(':/workspace'));
    assert.equal(mounts.length, 1);
    assert.ok(mounts[0]!.endsWith(':/workspace:rw'));
    assert.ok(!argv.some((a) => a.includes('/var/run/docker.sock')), 'no Docker socket mount');
    assert.ok(argv.some((a) => a === '-w' && argv[argv.indexOf(a) + 1] === '/workspace'));
    // Minimal runtime environment: HOME repointed into workspace, no host HOME passthrough.
    assert.ok(argv.some((a) => a === 'HOME=/workspace/.home'));
    assert.ok(argv[argv.length - 1] === PINNED_IMAGE, 'pinned image must be the final positional (entrypoint intact)');
    await sandbox.stop();
  });

  it('rejects a uid 0 sandbox identity at construction', () => {
    assert.throws(
      () => createRepositorySandbox({ ...baseOptions(createFakePersistentContainerDriver()), sandboxIdentity: { uid: 0, gid: 0, isPinned: false } } as never),
      /uid 0/,
    );
  });

  it('rejects an unpinned image (no :latest, no tag)', () => {
    assert.throws(
      () => createRepositorySandbox({ ...baseOptions(createFakePersistentContainerDriver()), image: 'node:latest' } as never),
      /sha256/,
    );
  });

  it('does not expose container id, pid, kill, or exec-target primitives on the public sandbox', () => {
    const sandbox = createRepositorySandbox(baseOptions(createFakePersistentContainerDriver()) as never);
    assert.equal(typeof (sandbox as unknown as Record<string, unknown>).containerId, 'undefined');
    assert.equal(typeof (sandbox as unknown as Record<string, unknown>).pid, 'undefined');
    assert.equal(typeof (sandbox as unknown as Record<string, unknown>).kill, 'undefined');
    assert.equal(typeof (sandbox as unknown as Record<string, unknown>).run, 'undefined');
    assert.equal(typeof (sandbox as unknown as Record<string, unknown>).spawn, 'undefined');
    assert.equal(typeof (sandbox as unknown as Record<string, unknown>).exec, 'undefined');
  });

  it('routes response frames by internal id and rejects stale/foreign ids', async () => {
    const driver = createFakePersistentContainerDriver({
      staleResponseBeforeNthRequest: {
        requestNumber: 1,
        id: 'foreign-response-id',
        response: { ok: false, error: 'foreign' },
      },
    });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const first = await sandbox.runTool({ tool: 'read', path: 'a' });
    assert.equal(first.ok, true);
    assert.equal(first.content, 'fake-read:a');
    const second = await sandbox.runTool({ tool: 'read', path: 'b' });
    assert.equal(second.ok, true);
    assert.equal(second.content, 'fake-read:b');
    await sandbox.stop();
  });

  it('injecting a hostile container id or runtime flag via the request cannot reach the runtime argv', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const before = driver.lastSpawnArgs.length;
    await sandbox.runTool({ tool: 'bash', command: 'x', args: ['--privileged', '; rm -rf /', '$(docker rm -f other)'] } as never);
    assert.equal(driver.spawnCount, 1, 'request arguments must never trigger a new runtime invocation');
    assert.equal(driver.lastSpawnArgs.length, before);
    await sandbox.stop();
  });

  it('terminates a runaway command on host timeout and returns a bounded terminal response (container stays alive)', async () => {
    const driver = createFakePersistentContainerDriver({ hangMs: 5_000 });
    const sandbox = createRepositorySandbox({ ...baseOptions(driver), toolTimeoutMs: 80 } as never);
    await sandbox.start();
    const t0 = Date.now();
    const res = await sandbox.runTool({ tool: 'bash', command: 'sleep', args: ['30'] });
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.ok(/timeout|cancelled/i.test((res as { error: string }).error));
    assert.ok(elapsed < 2_000, `timeout must settle quickly, took ${elapsed}ms`);
    // Container must survive the per-command timeout for reuse.
    const ok = await sandbox.runTool({ tool: 'read', path: 'a' });
    assert.equal(ok.ok, true, 'container must still be usable after a per-command timeout');
    await sandbox.stop();
  });

  it('propagates client cancellation (AbortSignal) to the owned command and settles boundedly', async () => {
    const driver = createFakePersistentContainerDriver({ hangMs: 5_000 });
    const sandbox = createRepositorySandbox({ ...baseOptions(driver), toolTimeoutMs: 30_000 } as never);
    await sandbox.start();
    const controller = new AbortController();
    const pending = sandbox.runTool({ tool: 'bash', command: 'sleep', args: ['30'] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    const res = await pending;
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.ok(/cancel|abort/i.test((res as { error: string }).error));
    assert.ok(elapsed < 2_000);
    await sandbox.stop();
  });

  it('serializes concurrent runTool calls (one in-flight command at a time)', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const session = driver.sessions[0]!;
    let inFlight = 0;
    let maxInFlight = 0;
    session.onCommandStart = () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); };
    session.onCommandEnd = () => { inFlight -= 1; };
    await Promise.all([
      sandbox.runTool({ tool: 'bash', command: 'a', args: [] }),
      sandbox.runTool({ tool: 'bash', command: 'b', args: [] }),
      sandbox.runTool({ tool: 'bash', command: 'c', args: [] }),
    ]);
    assert.equal(maxInFlight, 1, 'commands must be serialized');
    await sandbox.stop();
  });

  it('settles boundedly when the supervisor exits mid-request and marks the sandbox terminal', async () => {
    const driver = createFakePersistentContainerDriver({ exitOnNthRequest: 1 });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const res = await sandbox.runTool({ tool: 'read', path: 'a' });
    assert.equal(res.ok, false);
    // After the supervisor died, the sandbox must be terminal.
    await assert.rejects(() => sandbox.runTool({ tool: 'read', path: 'a' }), /stopped|teardown|terminal|unavailable/i);
  });

  it('teardown is awaited even if the supervisor never exits (forced removal by owned id)', async () => {
    const driver = createFakePersistentContainerDriver({ ignoreShutdown: true });
    const sandbox = createRepositorySandbox({ ...baseOptions(driver), shutdownGraceMs: 80 } as never);
    await sandbox.start();
    const owned = driver.lastContainerId;
    await sandbox.stop();
    assert.ok(driver.removedIds.includes(owned), 'forced removal by owned id must still run');
  });

  it('fresh instance gets a distinct owned container id and never reuses a prior one', async () => {
    const driver = createFakePersistentContainerDriver();
    const a = createRepositorySandbox(baseOptions(driver) as never);
    await a.start();
    const idA = driver.lastContainerId;
    await a.stop();

    const b = createRepositorySandbox(baseOptions(driver) as never);
    await b.start();
    const idB = driver.lastContainerId;
    await b.stop();
    assert.notEqual(idA, idB);
  });

  it('createPersistentContainerDriver resolves a real runtime path via direct lookup (no shell interpolation)', async () => {
    // The factory must not accept arbitrary caller targets; it resolves docker/podman itself.
    const driver = createPersistentContainerDriver({ containerRuntime: 'docker', resolvedRuntimePath: '/usr/local/bin/docker' });
    assert.equal(driver.runtimePath, '/usr/local/bin/docker');
  });

  it('removeContainer rejects a malformed/non-owned container id', async () => {
    const driver = createPersistentContainerDriver({ containerRuntime: 'docker', resolvedRuntimePath: '/usr/local/bin/docker', removeRunner: async () => ({ ok: true }) });
    await assert.rejects(() => driver.removeContainer('; rm -rf /'));
    await assert.rejects(() => driver.removeContainer('other-container'));
  });

  it('resolveRuntimeExecutable searches PATH directly with no host shell and returns the first executable match', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rt-resolve-'));
    try {
      // Place a fake 'docker' executable with an exec bit and a symlink to prove
      // realpath is applied. The resolver must NOT use `command -v`/`which`.
      const realDir = join(tmp, 'realbin');
      mkdirSync(realDir, { recursive: true });
      const target = join(realDir, 'docker');
      writeFileSync(target, '#!/bin/sh\necho hi\n', { mode: 0o755 });
      const linkDir = join(tmp, 'linkdir');
      mkdirSync(linkDir, { recursive: true });
      const link = join(linkDir, 'docker');
      symlinkSync(target, link);
      const resolved = resolveRuntimeExecutable('docker', `${linkDir}:${realDir}`);
      assert.equal(resolved, realpathSync(target), 'must resolve the symlink to its realpath without a shell');
      // A shell-based lookup would fail here because PATH only contains our dirs.
      assert.throws(() => resolveRuntimeExecutable('docker', '/nonexistent-dir-only'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
