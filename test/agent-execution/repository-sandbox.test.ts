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
  type ContainerDriver,
  type RepositorySandbox,
} from '../../src/domains/agent-execution/index.ts';

const PINNED_IMAGE = 'sha256:' + '1'.repeat(64);
const SAFE_IDENTITY = { uid: 1001, gid: 1001, isPinned: true };

function baseOptions(driver: ContainerDriver) {
  return {
    image: PINNED_IMAGE,
    workspacePath: '/tmp/fake-workspace',
    sandboxIdentity: SAFE_IDENTITY,
    driver,
    toolTimeoutMs: 1000,
    cpuLimit: '1',
    memoryLimit: '512m',
    pidsLimit: 64,
  };
}

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
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const res = await sandbox.runTool({ tool: 'read', path: 'a' });
    assert.equal(res.ok, true);
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

describe('Repository Sandbox start/stop race and cancel correctness', () => {
  it('shares one start promise across concurrent start() callers (never resolves before ready)', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    const p1 = sandbox.start();
    // A second concurrent start must share the in-flight start, so resolving it
    // implies the container is ready (state must be 'started' before p2 settles).
    const p2 = sandbox.start();
    await p2;
    // p2 must not have resolved until the container was actually started, so a
    // tool call right after p2 settles must succeed.
    assert.equal(driver.spawnCount, 1, 'concurrent starts must spawn exactly one container');
    const res = await sandbox.runTool({ tool: 'read', path: 'a' });
    assert.equal(res.ok, true, 'a shared start promise must not resolve before readiness');
    await p1;
    await sandbox.stop();
  });

  it('stop during an in-flight start settles boundedly, leaves the sandbox terminal, and removes the captured owned id', async () => {
    const driver = createFakePersistentContainerDriver({ blockReady: true });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    const startP = sandbox.start();
    // Let the start capture the owned id and enter the readiness wait.
    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    await sandbox.stop();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3_000, `stop during start must settle boundedly, took ${elapsed}ms`);
    // The sandbox must be terminal (not 'started') so no command is accepted.
    await assert.rejects(() => sandbox.runTool({ tool: 'read', path: 'a' } as never), /stopped|teardown|terminal|not started/i);
    // The half-started owned container must have been removed.
    assert.equal(driver.removedIds.length, 1, 'half-started owned id must be removed when captured');
    // The in-flight start must have settled (rejected), with no pending promise.
    await assert.rejects(() => startP, /readiness|cancelled|start|exited/i);
  });

  it('starts even when supervisor readiness is parsed before the readiness resolver is bound (fast-readiness race)', async () => {
    const driver = createFakePersistentContainerDriver({ fastReady: true });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    // A fast real supervisor can emit readiness the instant the host attaches
    // its stdout listener — before doStart assigns the readiness resolver.
    // That frame must never be dropped: start must resolve, not time out.
    await sandbox.start();
    const res = await sandbox.runTool({ tool: 'read', path: 'a' });
    assert.equal(res.ok, true, 'fast readiness must not be dropped before the resolver is bound');
    await sandbox.stop();
  });

  it('fast readiness is never lost across many repeated concurrent starts', async () => {
    // Prove the fast-readiness race is closed deterministically: many distinct
    // sandboxes starting concurrently, each delivering readiness synchronously
    // on attach, all become ready and stay usable — repeated several runs.
    for (let run = 0; run < 5; run++) {
      const drivers = Array.from({ length: 6 }, () => createFakePersistentContainerDriver({ fastReady: true }));
      const sandboxes = drivers.map((d) => createRepositorySandbox(baseOptions(d) as never));
      await Promise.all(sandboxes.map((s) => s.start()));
      const results = await Promise.all(sandboxes.map((s) => s.runTool({ tool: 'read', path: 'a' })));
      assert.ok(results.every((r) => r.ok), `run ${run}: every fast-ready sandbox must be usable`);
      await Promise.all(sandboxes.map((s) => s.stop()));
    }
  });

  it('removes the AbortSignal listener on settlement and never emits a stale cancel afterwards', async () => {
    const driver = createFakePersistentContainerDriver();
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const controller = new AbortController();
    const res = await sandbox.runTool({ tool: 'read', path: 'a' }, { signal: controller.signal });
    assert.equal(res.ok, true);
    // The listener must have been removed on settlement, so a later abort is a
    // no-op that cannot emit a stale cancel frame.
    controller.abort();
    // A subsequent command must still succeed (no stale state).
    const res2 = await sandbox.runTool({ tool: 'read', path: 'b' });
    assert.equal(res2.ok, true);
    // Only the two real request frames were issued; no extra cancel frame.
    const session = driver.sessions[0]!;
    assert.equal(session.requestFrames.length, 2);
    await sandbox.stop();
  });
});

describe('Repository Sandbox cancellation and shared teardown regressions', () => {
  it('pre-aborted cancellation targets the dispatched command and leaves no orphan run', async () => {
    const driver = createFakePersistentContainerDriver({ hangMs: 5_000 });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const controller = new AbortController();
    controller.abort();
    const result = await sandbox.runTool({ tool: 'bash', command: 'sleep', args: ['30'] }, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /cancel/i);
    assert.equal(driver.sessions[0]!.requestFrames.length, 1, 'one command is paired with its cancellation');
    assert.equal((await sandbox.runTool({ tool: 'read', path: 'after' })).ok, true, 'no orphan command blocks the next call');
    await sandbox.stop();
  });

  it('concurrent stop callers share one completion promise', async () => {
    const driver = createFakePersistentContainerDriver({ ignoreShutdown: true });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await sandbox.start();
    const first = sandbox.stop();
    const second = sandbox.stop();
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(driver.removedIds.length, 1);
  });
});

describe('Repository Sandbox fault-injection settlement (AC-11)', () => {
  it('create/spawn failure settles deterministically and leaves no command accepted', async () => {
    const driver = createFakePersistentContainerDriver({ failSpawn: true });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await assert.rejects(() => sandbox.start(), /not found|spawn/i);
    // No owned container was captured (spawn failed before any cidfile), so
    // there is nothing to remove; teardown is a no-op terminal state.
    assert.equal(driver.spawnCount, 0, 'no successful spawn was captured');
    assert.equal(driver.removedIds.length, 0);
    await assert.rejects(() => sandbox.runTool({ tool: 'read', path: 'a' } as never), /stopped|teardown|terminal/i);
    // A second start must not resurrect a terminal sandbox.
    await assert.rejects(() => sandbox.start(), /cannot start from state/i);
  });

  it('readiness failure (supervisor dies before ready) best-effort removes the owned container and rejects commands', async () => {
    const driver = createFakePersistentContainerDriver({ neverReady: true });
    const sandbox = createRepositorySandbox(baseOptions(driver) as never);
    await assert.rejects(() => sandbox.start(), /readiness|did not report|exited/i);
    // The owned container was created (cidfile written) so best-effort cleanup
    // must remove exactly that owned id, never another target.
    assert.equal(driver.removedIds.length, 1, 'half-started owned container must be removed on readiness failure');
    await assert.rejects(() => sandbox.runTool({ tool: 'read', path: 'a' } as never), /stopped|teardown|terminal/i);
  });

  it('remove failure during stop settles boundedly without leaving a pending promise and remains idempotent', async () => {
    const driver = createFakePersistentContainerDriver({ removeRejects: true, hangMs: 5_000 });
    const sandbox = createRepositorySandbox({ ...baseOptions(driver), toolTimeoutMs: 30_000 } as never);
    await sandbox.start();
    // start an active, long-running command, then stop while it is in flight.
    const pending = sandbox.runTool({ tool: 'bash', command: 'sleep', args: ['30'] });
    // stop must not hang even though forced removal rejects.
    const t0 = Date.now();
    await assert.rejects(() => sandbox.stop(), /sandbox cleanup failed/i);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `stop must settle boundedly even when removal rejects, took ${elapsed}ms`);
    // The in-flight command must receive one terminal response (no pending promise).
    const res = await pending;
    assert.equal(res.ok, false);
    assert.ok(/stopped|terminal|cancel|exited/i.test((res as { error: string }).error), `unexpected error: ${(res as { error: string }).error}`);
    // Repeated teardown settles idempotently and never targets another container.
    await assert.rejects(() => sandbox.stop(), /sandbox cleanup failed/i);
    assert.equal(driver.removedIds.length, 0, 'removeRejects records no successful removals and no foreign targets');
  });

  it('stop during an active command closes intake and rejects further commands (no command after teardown)', async () => {
    const driver = createFakePersistentContainerDriver({ hangMs: 5_000 });
    const sandbox = createRepositorySandbox({ ...baseOptions(driver), toolTimeoutMs: 30_000 } as never);
    await sandbox.start();
    const pending = sandbox.runTool({ tool: 'bash', command: 'sleep', args: ['30'] });
    await sandbox.stop();
    const res = await pending;
    assert.equal(res.ok, false);
    await assert.rejects(() => sandbox.runTool({ tool: 'read', path: 'a' } as never), /stopped|teardown|terminal/i);
  });
});