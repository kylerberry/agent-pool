/**
 * Persistent attempt sandbox — broker tests.
 *
 * The broker starts ONE persistent repository sandbox per attempt, proxies
 * read/write/edit/bash through the long-lived in-container supervisor over a
 * Unix socket, supports disconnect cancellation, bounds request/response/time,
 * and tears the sandbox down idempotently on stop. Cross-attempt broker
 * instances never share a sandbox or container.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSandboxBroker,
  createFakePersistentContainerDriver,
} from '../../src/domains/agent-execution/index.ts';

/** Create the intended workspace dir, then realpath it separately. */
function createWorkspace(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

async function brokerRequest(socketPath: string, request: unknown, opts: { closeAfterWrite?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let buffer = '';
    let settled = false;
    // Single-settlement: a client.destroy() that closes the socket without an
    // error or data event must reject rather than leave the promise pending.
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch {}
      fn();
    };
    client.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const response = buffer.slice(0, newline);
      settle(() => {
        try {
          resolve(JSON.parse(response));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    client.on('error', (err) => settle(() => reject(err)));
    client.on('close', () => settle(() => reject(new Error('broker client closed without a response'))));
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => { try { client.destroy(); } catch {} }, { once: true });
    }
    client.write(JSON.stringify(request) + '\n');
    if (opts.closeAfterWrite) {
      // Simulate a client that writes then disconnects immediately.
      setTimeout(() => { try { client.destroy(); } catch {} }, 5);
    }
  });
}

function socketPath(): string {
  return join(tmpdir(), `ppb-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

describe('Persistent Sandbox Broker', () => {
  it('forwards calls through one persistent sandbox', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    const workspacePath = createWorkspace(runtimeRoot, 'workspace');
    const sock = socketPath();
    const driver = createFakePersistentContainerDriver();
    const broker = createSandboxBroker({
      socketPath: sock,
      workspacePath,
      containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64),
      sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true },
      driver,
    });

    try {
      await broker.start();
      assert.equal(driver.spawnCount, 1, 'broker must start exactly one persistent container');
      const session = driver.sessions[0]!;

      await brokerRequest(sock, { tool: 'write', path: 'hello.txt', content: 'world' });
      const readRes = (await brokerRequest(sock, { tool: 'read', path: 'hello.txt' })) as { ok: boolean; content?: string };
      assert.equal(readRes.ok, true);
      assert.equal(readRes.content, 'fake-read:hello.txt');
      assert.equal(session.requestFrames.length, 2);
      const [write, read] = session.requestFrames as Array<Record<string, unknown>>;
      assert.equal(typeof write.id, 'string');
      assert.equal(typeof read.id, 'string');
      assert.deepEqual(write, { id: write.id, tool: 'write', path: 'hello.txt', content: 'world' });
      assert.deepEqual(read, { id: read.id, tool: 'read', path: 'hello.txt' });
    } finally {
      await broker.stop();
      if (existsSync(sock)) rmSync(sock);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('stops the persistent sandbox (owned container removed) on broker stop and is idempotent', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    const workspacePath = createWorkspace(runtimeRoot, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const sock = socketPath();
    const driver = createFakePersistentContainerDriver();
    const broker = createSandboxBroker({
      socketPath: sock,
      workspacePath,
      containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64),
      sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true },
      driver,
    });
    await broker.start();
    const owned = driver.lastContainerId;
    await broker.stop();
    await broker.stop();
    assert.ok(driver.removedIds.includes(owned));
  });

  it('concurrent stop callers await the same owned teardown completion', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-concurrent-stop-'));
    const workspacePath = createWorkspace(runtimeRoot, 'workspace');
    const sock = socketPath();
    const driver = createFakePersistentContainerDriver({ ignoreShutdown: true });
    const broker = createSandboxBroker({
      socketPath: sock, workspacePath, containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
    });
    try {
      await broker.start();
      const first = broker.stop();
      const second = broker.stop();
      assert.equal(first, second);
      await Promise.all([first, second]);
      assert.equal(driver.removedIds.length, 1);
    } finally {
      await broker.stop();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('a post-listen server failure resolves terminalFailure and tears down the owned container', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-postlisten-fail-'));
    const workspacePath = createWorkspace(runtimeRoot, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
    const sock = socketPath();
    const driver = createFakePersistentContainerDriver();
    const crash = new Error('simulated post-listen server crash');
    const broker = createSandboxBroker({
      socketPath: sock, workspacePath, containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
      _testOnlyFailAfterListen: crash,
    });
    try {
      await broker.start();
      // The post-listen failure must surface on the terminalFailure channel...
      const failure = await broker.terminalFailure;
      assert.equal(failure, crash, 'terminalFailure must resolve with the post-listen server error');
      // ...and the launcher's cleanup() awaits the shared stop() after
      // terminalFailure resolves, which tears down the owned container.
      await broker.stop();
      assert.equal(driver.removedIds.length, 1, 'a post-listen server failure must tear down the owned container');
    } finally {
      await broker.stop();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('each broker instance gets a fresh persistent container; cross-attempt containers never match', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    mkdirSync(join(runtimeRoot, 'workspace'), { recursive: true });
    const driver = createFakePersistentContainerDriver();
    const sockA = socketPath();
    const brokerA = createSandboxBroker({
      socketPath: sockA, workspacePath: join(runtimeRoot, 'workspace'), containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
    });
    await brokerA.start();
    const idA = driver.lastContainerId;
    await brokerA.stop();

    const sockB = socketPath();
    const brokerB = createSandboxBroker({
      socketPath: sockB, workspacePath: join(runtimeRoot, 'workspace'), containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
    });
    await brokerB.start();
    const idB = driver.lastContainerId;
    await brokerB.stop();
    assert.notEqual(idA, idB);
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it('rejects oversized requests boundedly', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    const workspacePath = createWorkspace(runtimeRoot, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const sock = socketPath();
    const driver = createFakePersistentContainerDriver();
    const broker = createSandboxBroker({
      socketPath: sock, workspacePath, containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
    });
    try {
      await broker.start();
      const huge = { tool: 'write', path: 'big.txt', content: 'x'.repeat(4 * 1024 * 1024) };
      const res = (await brokerRequest(sock, huge)) as { ok: boolean; error?: string };
      assert.equal(res.ok, false);
      assert.ok(/too large/i.test(res.error ?? ''));
    } finally {
      await broker.stop();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('returns a bounded error for malformed JSON', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    const workspacePath = createWorkspace(runtimeRoot, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const sock = socketPath();
    const { connect } = await import('node:net');
    const driver = createFakePersistentContainerDriver();
    const broker = createSandboxBroker({
      socketPath: sock, workspacePath, containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
    });
    try {
      await broker.start();
      const res: unknown = await new Promise((resolve, reject) => {
        const client = connect(sock);
        let buf = '';
        client.on('data', (c) => { buf += c; if (buf.includes('\n')) { resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))); client.end(); } });
        client.on('error', reject);
        client.write('{not json\n');
      });
      assert.equal((res as { ok: boolean }).ok, false);
    } finally {
      await broker.stop();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('disconnects after write return a bounded terminal response, not a hang', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    const workspacePath = createWorkspace(runtimeRoot, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const sock = socketPath();
    const driver = createFakePersistentContainerDriver({ hangMs: 3_000 });
    const broker = createSandboxBroker({
      socketPath: sock, workspacePath, containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
      brokerRequestTimeoutMs: 500,
    });
    try {
      await broker.start();
      // Client writes a long-running request then disconnects. The broker must
      // cancel the owned command and not keep the sandbox busy forever.
      await assert.rejects(
        () => brokerRequest(sock, { tool: 'bash', command: 'sleep', args: ['30'] }, { closeAfterWrite: true }),
      );
      // Sandbox must remain usable for the next request (per-command cancellation only).
      const ok = (await brokerRequest(sock, { tool: 'read', path: 'a.txt' })) as { ok: boolean };
      assert.equal(ok.ok, true);
    } finally {
      await broker.stop();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('rolls back the owned container when the listen socket fails (no leak on start failure)', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-rollback-'));
    const workspacePath = createWorkspace(runtimeRoot, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    // A path far beyond the AF_UNIX socket name limit (>=108) makes listen()
    // fail with ENAMETOOLONG after the sandbox container is already created.
    const longSock = join(runtimeRoot, 'x'.repeat(160) + '.sock');
    const driver = createFakePersistentContainerDriver();
    const broker = createSandboxBroker({
      socketPath: longSock, workspacePath, containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64), sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true }, driver,
    });
    try {
      await assert.rejects(() => broker.start());
      // The sandbox was started (one container spawned) so the rollback MUST
      // remove exactly that owned container rather than leaking it.
      assert.equal(driver.spawnCount, 1, 'sandbox container was created before listen failed');
      assert.equal(driver.removedIds.length, 1, 'listen-failure rollback must tear down the owned container');
      assert.equal(driver.removedIds[0], driver.lastContainerId);
    } finally {
      await broker.stop();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
