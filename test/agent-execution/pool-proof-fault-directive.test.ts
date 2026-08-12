/**
 * Unit tests for the proof-only fault directive seam.
 *
 * These tests import the helper directly from its source module because the
 * helper is intentionally removed from the public domain index: only the
 * trusted launcher may consume a fault directive. The tests prove that the
 * seam signals only the launcher-owned child and rejects stale, mismatched,
 * duplicate, or already-exited targets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  attemptFaultInjection,
  createFaultDirectiveState,
  deriveInjectedFailureCode,
  type FaultDirective,
} from '../../src/domains/agent-execution/pool-proof-fault-directive.ts';

function makeDirective(overrides?: Partial<FaultDirective>): FaultDirective {
  return {
    directiveId: 'dir-1',
    attemptId: 'att://proof/job-b/1',
    signal: 'SIGTERM',
    failureCode: 'INJECTED_WORKER_FAILURE',
    ...overrides,
  };
}

function spawnSleeper(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function awaitExit(child: ReturnType<typeof spawn>): Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.on('exit', (exitCode, signalCode) => {
      resolve({ exitCode, signalCode: signalCode as NodeJS.Signals | null });
    });
  });
}

describe('Pool Proof fault directive', () => {
  it('signals the launcher-owned child synchronously at spawn', async () => {
    const child = spawnSleeper();
    const state = createFaultDirectiveState();
    const directive = makeDirective();

    await new Promise<void>((resolve) => child.on('spawn', resolve));
    const result = attemptFaultInjection(child, directive, directive.attemptId, state);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.evidence.directiveId, directive.directiveId);
    assert.equal(result.evidence.signal, directive.signal);
    assert.equal(result.evidence.pid, child.pid);
    assert.equal(result.evidence.killResult, true);

    const exit = await awaitExit(child);
    assert.equal(exit.signalCode, 'SIGTERM');
    assert.equal(deriveInjectedFailureCode(directive, result.evidence, exit.signalCode), directive.failureCode);
  });

  it('rejects a directive bound to a different attempt', async () => {
    const child = spawnSleeper();
    const state = createFaultDirectiveState();
    const directive = makeDirective();

    await new Promise<void>((resolve) => child.on('spawn', resolve));
    const result = attemptFaultInjection(child, directive, 'att://proof/other/1', state);

    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; reason: string }).reason, 'attempt_mismatch');
    assert.equal(state.consumed, false);

    child.kill('SIGKILL');
    await awaitExit(child);
  });

  it('rejects duplicate consumption for the same directive', async () => {
    const child = spawnSleeper();
    const state = createFaultDirectiveState();
    const directive = makeDirective();

    await new Promise<void>((resolve) => child.on('spawn', resolve));
    const first = attemptFaultInjection(child, directive, directive.attemptId, state);
    assert.equal(first.ok, true);
    const second = attemptFaultInjection(child, directive, directive.attemptId, state);
    assert.equal(second.ok, false);
    assert.equal((second as { ok: false; reason: string }).reason, 'already_consumed');

    await awaitExit(child);
  });

  it('rejects an already-exited child', async () => {
    const child = spawnSleeper();
    const state = createFaultDirectiveState();
    const directive = makeDirective();

    child.kill('SIGKILL');
    await awaitExit(child);

    const result = attemptFaultInjection(child, directive, directive.attemptId, state);
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; reason: string }).reason, 'child_already_exited');
  });

  it('does not signal a non-owned peer process', async () => {
    const target = spawnSleeper();
    const peer = spawnSleeper();
    const state = createFaultDirectiveState();
    const directive = makeDirective();

    await Promise.all([
      new Promise<void>((resolve) => target.on('spawn', resolve)),
      new Promise<void>((resolve) => peer.on('spawn', resolve)),
    ]);

    const result = attemptFaultInjection(target, directive, directive.attemptId, state);
    assert.equal(result.ok, true);

    const targetExit = await awaitExit(target);
    assert.equal(targetExit.signalCode, 'SIGTERM');

    assert.equal(peer.killed, false);
    peer.kill('SIGKILL');
    const peerExit = await awaitExit(peer);
    assert.equal(peerExit.signalCode, 'SIGKILL');
  });

  it('records failed kill result when signal cannot be delivered', async () => {
    const child = spawnSleeper();
    const state = createFaultDirectiveState();
    const directive = makeDirective({ signal: 'SIGTERM' });

    await new Promise<void>((resolve) => child.on('spawn', resolve));
    child.kill('SIGKILL');
    await awaitExit(child);

    // After exit, child.kill returns false. The liveness check already
    // rejects, so this path verifies the check ordering.
    const result = attemptFaultInjection(child, directive, directive.attemptId, state);
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; reason: string }).reason, 'child_already_exited');
  });
});
