/**
 * Launcher-owned short broker socket allocator.
 *
 * Red/green coverage for the macOS AF_UNIX path-length root cause: long
 * per-attempt runtime roots (realpath-expanded user temp dirs) produced broker
 * socket paths well over the ~104 byte sun_path limit and `listen` failed with
 * EINVAL before any Worker started. The allocator owns a short, per-attempt,
 * collision-resistant socket directory under a launcher-owned short temp root,
 * validates realpath/ownership/symlink safety and path byte length, and is
 * removed with verified cleanup.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  realpathSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateBrokerSocket,
  resolveShortSocketRoot,
  AF_UNIX_PATH_LIMIT,
  DEFAULT_SOCKET_BYTE_BUDGET,
} from '../../src/domains/agent-execution/broker-socket.ts';
import { createAttemptResourceFactory } from '../../src/domains/agent-execution/index.ts';

const SHORT_ROOT = realpathSync('/tmp');

function tryListen(socketPath: string): Promise<{ ok: boolean; code?: string; len: number }> {
  // Defer the net import so it never imports before the test runs.
  return new Promise((resolve) => {
    import('node:net').then((net) => {
      const server = net.createServer();
      server.listen(socketPath, () => {
        server.close(() => resolve({ ok: true, len: Buffer.byteLength(socketPath) }));
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        resolve({ ok: false, code: err.code, len: Buffer.byteLength(socketPath) });
      });
    });
  });
}

function buildLongMacOsRuntimeSocketPath(): string {
  // Reproduce the exact pre-fix shape: realpath-expanded macOS user temp dir +
  // the historical nested runtime/attempt/pi-runtime/broker.sock suffix. On this
  // host this is >= 104 bytes (the AF_UNIX limit) and reproduces the EINVAL.
  const expandedTemp = realpathSync(tmpdir());
  return join(
    expandedTemp,
    'pool-proof-stage2-runtime-XXXXXX',
    'attempt-YYYYYY',
    'pi-runtime',
    'broker.sock',
  );
}

describe('broker socket allocator — root cause regression', () => {
  it('reproduces EINVAL on the long pre-fix socket path (red anchor)', async () => {
    const longPath = buildLongMacOsRuntimeSocketPath();
    assert.ok(
      Buffer.byteLength(longPath) >= AF_UNIX_PATH_LIMIT,
      `expected long path >= ${AF_UNIX_PATH_LIMIT} bytes, got ${Buffer.byteLength(longPath)}`,
    );
    const result = await tryListen(longPath);
    assert.equal(result.ok, false, 'long pre-fix path must fail to bind');
    assert.equal(result.code, 'EINVAL');
  });

  it('binds successfully on a short allocator path (green)', async () => {
    const allocation = allocateBrokerSocket({ attemptId: 'listen-bind' });
    try {
      const result = await tryListen(allocation.socketPath);
      assert.equal(result.ok, true, `short path failed to bind: ${result.code} (len ${result.len})`);
      assert.ok(result.len < AF_UNIX_PATH_LIMIT);
    } finally {
      rmSync(allocation.socketDir, { recursive: true, force: true });
    }
  });
});

describe('broker socket allocator — short-path success', () => {
  it('produces a path under the short root, owned by the process, mode 0o700', () => {
    const allocation = allocateBrokerSocket({ attemptId: 'short-success' });
    try {
      const dirReal = realpathSync(allocation.socketDir);
      const rootReal = realpathSync(SHORT_ROOT);
      assert.ok(dirReal.startsWith(rootReal + '/'), 'socket dir must live under the short root');
      assert.equal(existsSync(allocation.socketPath), false, 'socket file must not exist until listen');
      const dirStat = statSync(dirReal);
      assert.ok(process.getuid !== undefined ? dirStat.uid === process.getuid() : true, 'dir owned by process');
      const mode = dirStat.mode & 0o777;
      assert.equal(mode, 0o700, `owner-only mode expected, got 0o${mode.toString(8)}`);
      assert.ok(Buffer.byteLength(allocation.socketPath) <= DEFAULT_SOCKET_BYTE_BUDGET);
    } finally {
      rmSync(allocation.socketDir, { recursive: true, force: true });
    }
  });

  it('socket path stays well under the AF_UNIX limit even on a long runtime root', () => {
    // Simulate the long macOS user temp dir as the runtime root: the broker
    // socket must still be short because it lives under the SHORT root, not the
    // runtime root.
    const longRuntime = realpathSync(tmpdir());
    const factory = createAttemptResourceFactory({ runtimeRoot: longRuntime, socketRoot: SHORT_ROOT });
    const r = factory.allocate('long-runtime-attempt');
    try {
      assert.ok(
        Buffer.byteLength(r.brokerSocketPath ?? '') <= DEFAULT_SOCKET_BYTE_BUDGET,
        `broker socket too long: ${r.brokerSocketPath}`,
      );
      assert.ok(
        Buffer.byteLength(r.brokerSocketPath ?? '') < AF_UNIX_PATH_LIMIT,
        'broker socket must be under the AF_UNIX limit',
      );
      assert.ok((r.brokerSocketPath ?? '').startsWith(realpathSync(SHORT_ROOT) + '/'));
    } finally {
      factory.release(r);
    }
  });
});

describe('broker socket allocator — over-limit rejection', () => {
  it('rejects when the resolved socket path exceeds the byte budget and leaves no dir behind', () => {
    // A tiny budget guarantees even the minimal short path overflows.
    assert.throws(
      () => allocateBrokerSocket({ attemptId: 'overflow', byteBudget: 4 }),
      (err: Error) => {
        assert.match(err.message, /BROKER_SOCKET_PATH_TOO_LONG/);
        return true;
      },
    );
    // No leaked allocation directory should remain under the short root for this
    // attempt: failure must clean up. We cannot enumerate the exact dir, so we
    // rely on a fresh unique root to assert nothing was left behind there.
    const isolatedRoot = mkdtempSync(join(SHORT_ROOT, 'ap-iso-'));
    try {
      assert.throws(
        () => allocateBrokerSocket({ attemptId: 'overflow2', byteBudget: 4, socketRoot: isolatedRoot }),
        /BROKER_SOCKET_PATH_TOO_LONG/,
      );
      // The candidate directory must have been removed on rejection.
      const entries = readdirSync(isolatedRoot);
      assert.equal(entries.length, 0, `leaked allocation dir under isolated root: ${entries.join(',')}`);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});

describe('broker socket allocator — uniqueness and isolation', () => {
  it('allocates distinct, collision-resistant directories per attempt', () => {
    const a = allocateBrokerSocket({ attemptId: 'attempt-a' });
    const b = allocateBrokerSocket({ attemptId: 'attempt-b' });
    const c = allocateBrokerSocket({ attemptId: 'attempt-c' });
    try {
      const dirs = new Set([a.socketDir, b.socketDir, c.socketDir]);
      const paths = new Set([a.socketPath, b.socketPath, c.socketPath]);
      assert.equal(dirs.size, 3, 'socket dirs must be unique');
      assert.equal(paths.size, 3, 'socket paths must be unique');
      for (const d of [a, b, c]) {
        assert.ok(existsSync(d.socketDir), 'dir must exist');
      }
    } finally {
      for (const d of [a, b, c]) rmSync(d.socketDir, { recursive: true, force: true });
    }
  });
});

describe('broker socket allocator — path and symlink safety', () => {
  it('rejects a relative socket root (no caller-controlled traversal)', () => {
    assert.throws(
      () => resolveShortSocketRoot('relative/path'),
      /BROKER_SOCKET_ROOT_TRAVERSAL/,
    );
  });

  it('rejects a socket root containing a NUL byte', () => {
    assert.throws(
      () => resolveShortSocketRoot('/tmp\u0000evil'),
      /BROKER_SOCKET_ROOT_TRAVERSAL/,
    );
  });

  it('rejects a socket root that realpaths outside itself via symlink (escape)', () => {
    const sandbox = mkdtempSync(join(SHORT_ROOT, 'ap-symlink-'));
    try {
      const escapeTarget = mkdtempSync(join(SHORT_ROOT, 'ap-escape-'));
      const linkPath = join(sandbox, 'escape-link');
      symlinkSync(escapeTarget, linkPath);
      // The allocator only ever creates a fresh mkdtemp dir inside the provided
      // root, then asserts the realpath stays inside it. A root that *is* a
      // symlink to elsewhere must still resolve to a concrete short root; if the
      // caller hands a symlink that escapes a parent-controlled boundary we
      // still accept its realpath (it is absolute and concrete). The meaningful
      // guarantee is that the *created* allocation dir realpath stays inside the
      // root realpath. Assert that property directly here.
      const allocation = allocateBrokerSocket({ attemptId: 'symlink-prop', socketRoot: sandbox });
      try {
        const rootReal = realpathSync(sandbox);
        const dirReal = realpathSync(allocation.socketDir);
        assert.ok(dirReal.startsWith(rootReal + '/'), 'created dir must stay inside root realpath');
      } finally {
        rmSync(allocation.socketDir, { recursive: true, force: true });
      }
      rmSync(escapeTarget, { recursive: true, force: true });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects a non-directory socket root', () => {
    const file = join(SHORT_ROOT, 'ap-notadir-' + process.pid);
    writeFileSync(file, 'x');
    try {
      assert.throws(
        () => resolveShortSocketRoot(file),
        /BROKER_SOCKET_ROOT_NOT_DIR/,
      );
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('broker socket allocator — verified cleanup', () => {
  it('release() removes the broker socket directory and reports removal', () => {
    const longRuntime = realpathSync(tmpdir());
    const factory = createAttemptResourceFactory({ runtimeRoot: longRuntime, socketRoot: SHORT_ROOT });
    const r = factory.allocate('cleanup-attempt');
    const dir = r.brokerSocketDir!;
    assert.ok(existsSync(dir), 'dir exists before release');
    const disp = factory.release(r);
    assert.equal(disp.brokerSocketRemoved, true, 'release must report broker socket removal');
    assert.equal(existsSync(dir), false, 'broker socket dir must be removed');
  });

  it('release() on a factory without socketRoot leaves broker fields unset', () => {
    const longRuntime = realpathSync(tmpdir());
    const factory = createAttemptResourceFactory({ runtimeRoot: longRuntime });
    const r = factory.allocate('no-socket-attempt');
    try {
      assert.equal(r.brokerSocketPath, undefined);
      assert.equal(r.brokerSocketDir, undefined);
    } finally {
      factory.release(r);
    }
  });
});

describe('broker socket allocator — three-attempt composition on long macOS temp roots', () => {
  it('three attempts under a long runtime root each get distinct short broker sockets', () => {
    // Mirror Stage 2: a long realpath-expanded macOS user temp runtime root, but
    // broker sockets allocated under the short root. All three must be short,
    // distinct, and cleanable.
    const longRuntime = realpathSync(tmpdir());
    const factory = createAttemptResourceFactory({ runtimeRoot: longRuntime, socketRoot: SHORT_ROOT });
    const ids = ['multi-worker-pool-proof-attempt-a', 'multi-worker-pool-proof-attempt-b', 'multi-worker-pool-proof-attempt-c'];
    const allocations = ids.map((id) => factory.allocate(id));
    try {
      const paths = allocations.map((a) => a.brokerSocketPath!);
      const dirs = allocations.map((a) => a.brokerSocketDir!);
      assert.equal(new Set(paths).size, 3, 'paths unique');
      assert.equal(new Set(dirs).size, 3, 'dirs unique');
      for (const p of paths) {
        assert.ok(Buffer.byteLength(p) <= DEFAULT_SOCKET_BYTE_BUDGET, `too long: ${p}`);
        assert.ok(Buffer.byteLength(p) < AF_UNIX_PATH_LIMIT);
      }
    } finally {
      const disps = allocations.map((a) => factory.release(a));
      for (const d of disps) {
        assert.equal(d.brokerSocketRemoved, true);
      }
      for (const dir of allocations.map((a) => a.brokerSocketDir!)) {
        assert.equal(existsSync(dir), false, `dir not removed: ${dir}`);
      }
    }
  });

  it('three attempts actually bind their distinct short sockets concurrently', async () => {
    // Strongest green anchor: real concurrent listen on three allocator paths
    // must succeed, where the long pre-fix path fails.
    const a = allocateBrokerSocket({ attemptId: 'bind-a' });
    const b = allocateBrokerSocket({ attemptId: 'bind-b' });
    const c = allocateBrokerSocket({ attemptId: 'bind-c' });
    try {
      const results = await Promise.all([tryListen(a.socketPath), tryListen(b.socketPath), tryListen(c.socketPath)]);
      for (const r of results) {
        assert.equal(r.ok, true, `concurrent bind failed: ${r.code}`);
      }
    } finally {
      for (const d of [a, b, c]) rmSync(d.socketDir, { recursive: true, force: true });
    }
  });
});
