import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositorySandbox, createSandboxBroker, type BrokerResponse } from '../../src/domains/agent-execution/index.ts';

async function brokerRequest(socketPath: string, request: unknown): Promise<unknown> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let buffer = '';
    let resolved = false;
    client.on('data', (chunk) => {
      if (resolved) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      resolved = true;
      const response = buffer.slice(0, newline);
      client.end();
      try {
        resolve(JSON.parse(response));
      } catch (e) {
        reject(e);
      }
    });
    client.on('error', reject);
    client.write(JSON.stringify(request) + '\n');
  });
}

function socketPath(): string {
  return join(tmpdir(), `ppb-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function isSafeRelativePath(path?: string): boolean {
  if (typeof path !== 'string') return false;
  if (/[\u0000-\u001f]/.test(path)) return false;
  if (path.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(path) || path.startsWith('\\')) return false;
  return !path.replace(/\\/g, '/').split('/').includes('..');
}

function makeRecordingFake() {
  const invocations: unknown[] = [];
  return {
    invocations,
    fake: {
      pid: 0,
      exitCode: 0,
      kill: () => true,
      async runTool(request: unknown): Promise<BrokerResponse> {
        invocations.push(request);
        const req = request as { tool: string; path?: string; command?: string };
        if (req.path !== undefined && !isSafeRelativePath(req.path)) {
          return { ok: false, error: 'path outside workspace' };
        }
        switch (req.tool) {
          case 'read':
            return { ok: true, content: `fake-read:${req.path}` };
          case 'write':
            return { ok: true };
          case 'edit':
            return { ok: true };
          case 'bash':
            return { ok: true, exitCode: 0, stdout: `fake-bash:${req.command}`, stderr: '' };
          default:
            return { ok: false, error: 'unknown tool' };
        }
      },
    },
  };
}

describe('Repository Sandbox identity', () => {
  it('rejects a uid 0 sandbox identity at construction time', () => {
    assert.throws(
      () =>
        createRepositorySandbox({
          image: 'sha256:' + 'f'.repeat(64),
          workspacePath: '/tmp/fake-workspace',
          sandboxIdentity: { uid: 0, gid: 1001, isPinned: false },
        }),
      /uid 0 is not permitted/,
    );
  });

  it('accepts a non-root sandbox identity', () => {
    const sandbox = createRepositorySandbox({
      image: 'sha256:' + 'f'.repeat(64),
      workspacePath: '/tmp/fake-workspace',
      sandboxIdentity: { uid: 1001, gid: 1001, isPinned: true },
    });
    assert.equal(sandbox.image, 'sha256:' + 'f'.repeat(64));
  });
});

describe('Sandbox Broker', () => {
  it('proxies read/write/edit/bash through a fake sandbox and records invocations', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    mkdirSync(join(runtimeRoot, 'workspace'), { recursive: true });
    const workspacePath = realpathSync(join(runtimeRoot, 'workspace'));
    const sock = socketPath();
    const { invocations, fake } = makeRecordingFake();
    const broker = createSandboxBroker({
      socketPath: sock,
      workspacePath,
      containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64),
      fake,
    });

    try {
      await broker.start();

      const writeResult = (await brokerRequest(sock, { tool: 'write', path: 'hello.txt', content: 'world' })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(writeResult.ok, true, `write failed: ${writeResult.error}`);

      const readResult = (await brokerRequest(sock, { tool: 'read', path: 'hello.txt' })) as {
        ok: boolean;
        content?: string;
      };
      assert.equal(readResult.ok, true);
      assert.equal(readResult.content, 'fake-read:hello.txt');

      const editResult = (await brokerRequest(sock, { tool: 'edit', path: 'hello.txt', oldText: 'world', newText: 'earth' })) as {
        ok: boolean;
      };
      assert.equal(editResult.ok, true);

      const bashResult = (await brokerRequest(sock, { tool: 'bash', command: 'echo', args: ['ok'] })) as {
        ok: boolean;
        exitCode?: number;
      };
      assert.equal(bashResult.ok, true);
      assert.equal(bashResult.exitCode, 0);

      assert.equal(invocations.length, 4);
      assert.equal((invocations[0] as { tool: string }).tool, 'write');
      assert.equal((invocations[1] as { tool: string }).tool, 'read');
      assert.equal((invocations[2] as { tool: string }).tool, 'edit');
      assert.equal((invocations[3] as { tool: string }).tool, 'bash');
    } finally {
      await broker.stop();
      if (existsSync(sock)) rmSync(sock);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths by asking the sandbox', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'broker-'));
    const workspacePath = join(runtimeRoot, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
    const sock = socketPath();
    const { fake } = makeRecordingFake();
    const broker = createSandboxBroker({
      socketPath: sock,
      workspacePath,
      containerRuntime: 'docker',
      image: 'sha256:' + 'f'.repeat(64),
      fake,
    });

    try {
      await broker.start();
      const result = (await brokerRequest(sock, { tool: 'read', path: '/etc/passwd' })) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('outside workspace'));
    } finally {
      await broker.stop();
      if (existsSync(sock)) rmSync(sock);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
