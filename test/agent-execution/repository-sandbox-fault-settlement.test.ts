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
