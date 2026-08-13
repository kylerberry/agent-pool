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
