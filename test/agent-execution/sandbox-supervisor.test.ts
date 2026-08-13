/**
 * In-container repository tool supervisor protocol tests.
 *
 * These drive the REAL supervisor script (broker.mjs) directly on the host by
 * spawning it as a child process with an overridable workspace, so the exact
 * stdin/stdout frame protocol is exercised without Docker:
 *
 *   - readiness frame, read/write/bash execution
 *   - cancel requires targetId to EXACTLY equal the in-flight command id;
 *     a stale/foreign cancel never kills the current command
 *   - a cancel with no matching in-flight command resolves as no-such-target
 *   - an output flood is killed boundedly and yields ONE valid JSON response
 *
 * broker.mjs defaults WORKSPACE to /workspace inside the container; here it is
 * pointed at a temp dir via AGENT_POOL_SANDBOX_WORKSPACE.
 *
 * Exit handling: every test registers the exit waiter BEFORE issuing the
 * shutdown control frame and closing stdin. A fast-exiting child can fire
 * 'exit' in the gap between send(shutdown)+stdin.end() and a subsequently
 * attached 'exit' listener; attaching the listener first and resolving it
 * immediately for an already-exited child guarantees the await never hangs.
 * The finally block force-kills and re-awaits the child so a failing assertion
 * (which bypasses the orderly shutdown path) can never leave an orphaned broker
 * keeping the test process alive.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BROKER_PATH = resolve(__dirname, '..', '..', 'packages', 'worker-harness', 'profiles', 'pool-proof-builder', 'broker.mjs');

type Supervisor = {
  readonly child: ChildProcessWithoutNullStreams;
  nextFrame(timeoutMs?: number): Promise<Record<string, unknown>>;
  send(frame: Record<string, unknown>): void;
  close(): void;
};

/**
 * Resolves once the child has exited. If the child already exited (exitCode or
 * signalCode set), resolves immediately; otherwise attaches a one-shot 'exit'
 * listener. Create this promise BEFORE sending shutdown / closing stdin so a
 * fast exit between those actions and listener attachment cannot hang the await.
 */
function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((r) => child.once('exit', () => r()));
}

function startSupervisor(workspace: string): Promise<Supervisor> {
  return new Promise((resolveSup, rejectSup) => {
    const child = spawn(process.execPath, [BROKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', AGENT_POOL_SANDBOX_WORKSPACE: workspace },
    });
    let buffer = '';
    const pending: Array<(frame: Record<string, unknown>) => void> = [];
    let closed = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          const waiter = pending.shift();
          if (waiter) waiter(frame);
        } catch {
          // ignore non-JSON noise
        }
      }
    });
    child.on('error', rejectSup);
    child.on('exit', () => {
      closed = true;
      // Reject any still-pending waiter so a test never hangs.
      while (pending.length) {
        const w = pending.shift()!;
        w({ ok: false, error: '__supervisor_exited__', __exited: true });
      }
    });

    const sup: Supervisor = {
      child,
      nextFrame(timeoutMs = 8_000): Promise<Record<string, unknown>> {
        if (closed) return Promise.resolve({ ok: false, error: '__supervisor_exited__', __exited: true });
        return new Promise((resolveFrame, rejectFrame) => {
          const timer = setTimeout(() => rejectFrame(new Error(`supervisor frame timed out after ${timeoutMs}ms`)), timeoutMs);
          pending.push((frame) => { clearTimeout(timer); resolveFrame(frame); });
        });
      },
      send(frame: Record<string, unknown>): void {
        child.stdin.write(JSON.stringify(frame) + '\n');
      },
      close(): void {
        try { child.stdin.end(); } catch {}
      },
    };

    // Wait for the readiness frame.
    sup.nextFrame().then((frame) => {
      if (frame.ready === true) resolveSup(sup);
      else rejectSup(new Error(`unexpected first frame: ${JSON.stringify(frame)}`));
    }, rejectSup);
  });
}

/**
 * Force the broker child to exit and await it. Used in finally blocks so a
 * failing assertion (which skips the orderly shutdown path) cannot leave an
 * orphaned broker child holding the test process's event loop open.
 */
async function forceExit(sup: Supervisor): Promise<void> {
  try { sup.child.kill('SIGKILL'); } catch {}
  await waitForExit(sup.child);
}

describe('Sandbox supervisor protocol (real broker.mjs on host)', () => {
  it('emits readiness and executes read/write/bash', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sup-proto-'));
    let sup: Supervisor | undefined;
    try {
      writeFileSync(join(ws, 'hello.txt'), 'supervisor-data', 'utf8');
      sup = await startSupervisor(ws);
      sup.send({ id: 'r1', tool: 'read', path: 'hello.txt' });
      const readFrame = await sup.nextFrame();
      assert.equal(readFrame.ok, true);
      assert.equal(readFrame.content, 'supervisor-data');
      sup.send({ id: 'b1', tool: 'bash', command: '/bin/echo', args: ['pong'] });
      const bashFrame = await sup.nextFrame();
      assert.equal(bashFrame.ok, true);
      assert.equal((bashFrame.stdout as string).trim(), 'pong');
      // Attach the exit waiter BEFORE issuing shutdown / closing stdin.
      const exited = waitForExit(sup.child);
      sup.send({ control: 'shutdown', id: 'sd' });
      sup.close();
      await exited;
    } finally {
      if (sup) await forceExit(sup);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a stale/foreign cancel does not kill the current command; only an exact targetId match cancels', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sup-cancel-'));
    let sup: Supervisor | undefined;
    try {
      sup = await startSupervisor(ws);
      // Start a long-running command.
      sup.send({ id: 'cmd1', tool: 'bash', command: '/bin/sleep', args: ['8'] });
      // Foreign cancel: must NOT kill cmd1.
      sup.send({ control: 'cancel', targetId: 'foreign-id', id: 'c1' });
      const foreign = await sup.nextFrame();
      assert.equal(foreign.cancelled, false, 'foreign cancel must not cancel anything');
      assert.equal(foreign.error, 'no-such-target');
      // Exact-match cancel: cmd1 is still in flight, so it IS cancelled.
      sup.send({ control: 'cancel', targetId: 'cmd1', id: 'c2' });
      const exact = await sup.nextFrame();
      assert.equal(exact.cancelled, true, 'exact-targetId cancel must cancel the in-flight command (proving the foreign cancel did not)');
      const settled = await sup.nextFrame();
      assert.equal(settled.id, 'cmd1');
      assert.equal(settled.ok, false);
      assert.equal(settled.cancelled, true);
      const exited = waitForExit(sup.child);
      sup.send({ control: 'shutdown', id: 'sd' });
      sup.close();
      await exited;
    } finally {
      if (sup) await forceExit(sup);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a cancel with no in-flight command resolves as no-such-target (never kills a later command)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sup-nosuch-'));
    let sup: Supervisor | undefined;
    try {
      sup = await startSupervisor(ws);
      sup.send({ control: 'cancel', targetId: 'cmd1', id: 'c1' });
      const noTarget = await sup.nextFrame();
      assert.equal(noTarget.cancelled, false);
      assert.equal(noTarget.error, 'no-such-target');
      // A subsequent real command must still run normally.
      sup.send({ id: 'cmd2', tool: 'bash', command: '/bin/echo', args: ['ok'] });
      const ran = await sup.nextFrame();
      assert.equal(ran.ok, true);
      const exited = waitForExit(sup.child);
      sup.send({ control: 'shutdown', id: 'sd' });
      sup.close();
      await exited;
    } finally {
      if (sup) await forceExit(sup);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an output flood is killed boundedly and yields ONE valid, bounded JSON response', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sup-flood-'));
    let sup: Supervisor | undefined;
    try {
      sup = await startSupervisor(ws);
      const t0 = Date.now();
      // /bin/cat /dev/zero produces unbounded output until the supervisor kills
      // the command group on byte overflow.
      sup.send({ id: 'flood', tool: 'bash', command: '/bin/cat', args: ['/dev/zero'] });
      const frame = await sup.nextFrame(15_000);
      const elapsed = Date.now() - t0;
      assert.equal(frame.id, 'flood');
      assert.equal(frame.ok, false);
      assert.equal(typeof frame.error, 'string');
      assert.ok(/overflow|too large|cancelled/i.test(String(frame.error)), `expected bounded overflow error, got ${String(frame.error)}`);
      assert.ok(elapsed < 12_000, `flood must settle boundedly, took ${elapsed}ms`);
      // The response must be valid JSON (it parsed) and bounded: the frame is small.
      const raw = JSON.stringify(frame);
      assert.ok(raw.length < 4_000, `terminal response must be bounded, got ${raw.length} bytes`);
      const exited = waitForExit(sup.child);
      sup.send({ control: 'shutdown', id: 'sd' });
      sup.close();
      await exited;
    } finally {
      if (sup) await forceExit(sup);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('multibyte UTF-8 output is byte-bounded without corrupting code points', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sup-multibyte-'));
    let sup: Supervisor | undefined;
    try {
      sup = await startSupervisor(ws);
      // Part A: a normal multibyte command must round-trip exactly as valid
      // UTF-8 (byte-aware accumulation must not split or mangle code points).
      const expected = '😀漢字 Test—emoji+ CJK';
      sup.send({ id: 'mb1', tool: 'bash', command: '/bin/echo', args: [expected] });
      const mbFrame = await sup.nextFrame(15_000);
      assert.equal(mbFrame.ok, true, `multibyte echo must succeed: ${String(mbFrame.error)}`);
      const got = (mbFrame.stdout as string).trimEnd();
      assert.equal(got, expected, 'multibyte output must round-trip verbatim');
      // No U+FFFD replacement char from a mid-code-point slice.
      assert.ok(!got.includes('\uFFFD'), 'multibyte output must not contain replacement chars');
      assert.equal(Buffer.byteLength(got, 'utf8'), Buffer.byteLength(expected, 'utf8'));

      // Part B: a fast multibyte flood (4-byte emoji per line) must trip the
      // BYTE cap and be killed boundedly. A character-based cap would let this
      // 4-byte-per-char stream run far past the byte limit.
      const t0 = Date.now();
      sup.send({ id: 'mbflood', tool: 'bash', command: '/usr/bin/yes', args: ['😀'] });
      const floodFrame = await sup.nextFrame(20_000);
      const elapsed = Date.now() - t0;
      assert.equal(floodFrame.id, 'mbflood');
      assert.equal(floodFrame.ok, false, 'a multibyte flood exceeding the byte cap must be killed');
      assert.ok(/overflow|too large/i.test(String(floodFrame.error)), `expected overflow, got ${String(floodFrame.error)}`);
      assert.ok(elapsed < 15_000, `multibyte flood must settle boundedly, took ${elapsed}ms`);
      const rawFlood = JSON.stringify(floodFrame);
      assert.ok(rawFlood.length < 4_000, `terminal response must be bounded, got ${rawFlood.length} bytes`);

      const exited = waitForExit(sup.child);
      sup.send({ control: 'shutdown', id: 'sd' });
      sup.close();
      await exited;
    } finally {
      if (sup) await forceExit(sup);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
